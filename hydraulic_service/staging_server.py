"""Loopback-only, token-authenticated hydraulic staging rehearsal service.

This is NOT a cloud deployment or a production API. Only the bundled fictional
reference network is accepted. Storage must be an isolated absolute path.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from durable_jobs import DurableTestJobStore
from reference_model import REFERENCE_MODEL, get_reference_model, result_features
from service import ENGINE_VERSION

MAX_HTTP_REQUEST_BYTES = 8192
MAX_HTTP_RESPONSE_BYTES = 1_048_576
REQUESTER_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,100}$")
JOB_RE = re.compile(r"^/v1/jobs/([0-9a-f-]{36})$")


def validate_scenario(scenario):
    if scenario is None:
        return None
    if not isinstance(scenario, dict) or set(scenario) - {"type", "targetId", "factor", "headM"}:
        raise ValueError("Malformed test scenario")
    kind, target = scenario.get("type"), scenario.get("targetId")
    if kind == "PIPE_CLOSED" and target in {"P1", "P2", "P3"} and set(scenario) == {"type", "targetId"}:
        return scenario
    if kind == "DEMAND_CHANGE" and target in {"J1", "J2"} and set(scenario) == {"type", "targetId", "factor"}:
        factor = scenario["factor"]
        if type(factor) in (int, float) and 0 <= factor <= 3:
            return scenario
    if kind == "SOURCE_HEAD_CHANGE" and target == "R" and set(scenario) == {"type", "targetId", "headM"}:
        head = scenario["headM"]
        if type(head) in (int, float) and 0 <= head <= 200:
            return scenario
    raise ValueError("Scenario type, target or value not allowed for reference model")


class StagingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token, store):
        super().__init__(address, StagingHandler)
        self.token = token
        self.store = store
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self._process_jobs, name="epanet-test-jobs", daemon=True)

    def _process_jobs(self):
        self.store.recover_stale()
        while not self.stop_event.is_set():
            try:
                job = self.store.process_one()
                if job:
                    print(json.dumps({"event": "job_finished", "jobId": job["id"],
                                      "status": job["status"], "engine": ENGINE_VERSION}), flush=True)
            except Exception as exc:
                print(json.dumps({"event": "job_loop_error", "errorType": type(exc).__name__}), flush=True)
            self.stop_event.wait(0.1)

    def serve_forever(self, poll_interval=0.25):
        self.worker.start()
        try:
            super().serve_forever(poll_interval)
        finally:
            self.stop_event.set()
            self.worker.join(timeout=2)


class StagingHandler(BaseHTTPRequestHandler):
    server: StagingHTTPServer

    def log_message(self, format, *args):
        # Never log headers, token, submitted model or scenario payload.
        return

    def _reply(self, status, payload):
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        if len(body) > MAX_HTTP_RESPONSE_BYTES:
            status, body = 500, b'{"status":"error","message":"Result exceeds response limit"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authenticated(self):
        provided = self.headers.get("X-Sains-Simulation-Token", "")
        if not hmac.compare_digest(provided, self.server.token):
            self._reply(401, {"status": "error", "message": "Service authentication required"})
            return False
        return True

    def _requester(self):
        value = self.headers.get("X-Requester", "")
        if not REQUESTER_RE.fullmatch(value):
            raise ValueError("Valid requester identity required")
        return value

    def do_GET(self):
        if urlsplit(self.path).path == "/ping" and os.environ.get("SAINS_CONTAINER_MODE") == "1":
            self._reply(200, {"status": "ok"})
            return
        if not self._authenticated():
            return
        path = urlsplit(self.path).path
        if path == "/v1/health":
            self._reply(200, {"status": "CONNECTED", "environment": "STAGING_TEST_ONLY",
                              "engineVersion": ENGINE_VERSION, "modelType": "TEST MODEL",
                              "sainsModelStatus": "NOT_READY"})
            return
        if path == "/v1/jobs/latest":
            try:
                requester = self._requester()
                job = self.server.store.latest_completed(requested_by=requester, model_id=REFERENCE_MODEL["id"])
            except ValueError:
                self._reply(403, {"status": "error", "message": "Job access denied"})
                return
            if not job:
                self._reply(404, {"status": "error", "message": "No completed reference job"})
                return
            job["geojson"] = result_features(job["result"])
            self._reply(200, {"status": "success", "job": job, "modelType": "TEST MODEL",
                              "sainsModelStatus": "NOT_READY"})
            return
        matched = JOB_RE.fullmatch(path)
        if not matched:
            self._reply(404, {"status": "error", "message": "Unknown staging endpoint"})
            return
        try:
            requester = self._requester()
            job = self.server.store.get(matched.group(1), requested_by=requester)
        except (ValueError, PermissionError):
            self._reply(403, {"status": "error", "message": "Job access denied"})
            return
        if job is None:
            self._reply(404, {"status": "error", "message": "Job not found"})
            return
        if job["result"]:
            job["geojson"] = result_features(job["result"])
        self._reply(200, {"status": "success", "job": job, "modelType": "TEST MODEL",
                          "sainsModelStatus": "NOT_READY"})

    def do_POST(self):
        if not self._authenticated():
            return
        if urlsplit(self.path).path == "/v1/solve" and os.environ.get("SAINS_CONTAINER_MODE") == "1":
            try:
                size = int(self.headers.get("Content-Length", "-1"))
                if size < 0 or size > MAX_HTTP_REQUEST_BYTES:
                    self._reply(413, {"status": "error", "message": "Request size limit"})
                    return
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict) or set(data) - {"modelId", "scenario", "settings", "testFault"}:
                    raise ValueError("Malformed reference request")
                model = get_reference_model(data.get("modelId"))
                scenario = validate_scenario(data.get("scenario"))
                if (data.get("settings") or {"durationSeconds": 0}) != {"durationSeconds": 0}:
                    raise ValueError("Only static reference test is enabled")
                fault = data.get("testFault")
                if fault is not None and (os.environ.get("SAINS_STAGING_ENV") != "STAGING" or
                        os.environ.get("SAINS_STAGING_FAULT_TESTS") != "1" or
                        fault not in {"TIMEOUT_TEST_ONLY", "RESTART_WAIT_TEST_ONLY"} or
                        model["id"] != "TEST-REFERENCE-LOOP"):
                    raise ValueError("Staging TEST fault is disabled")
                payload = json.dumps({"testMode": True, "model": model, "scenario": scenario,
                                      "testFault": fault}).encode()
                started = time.perf_counter()
                # EPANET also creates an internal hydraulics file relative to
                # its process working directory. /app is read-only to the
                # unprivileged container user, so isolate every TEST run in a
                # writable, automatically removed directory.
                with tempfile.TemporaryDirectory(prefix="sains-epanet-process-") as process_dir:
                    process_env = {**os.environ, "HOME": process_dir,
                                   "MPLCONFIGDIR": process_dir, "TMPDIR": process_dir}
                    completed = subprocess.run(
                        [sys.executable, str(Path(__file__).resolve().with_name("job_worker.py"))],
                        input=payload, capture_output=True, timeout=30, check=False,
                        cwd=process_dir, env=process_env)
                duration_ms = (time.perf_counter() - started) * 1000
                if completed.returncode != 0:
                    # TEST-only diagnostics: do not log request data or credentials.
                    print(json.dumps({"event": "reference_solver_failed", "returnCode": completed.returncode,
                                      "stderr": completed.stderr.decode(errors="replace")[:300]}), flush=True)
                    self._reply(422, {"status": "error", "message": "Reference solver failed",
                                      "errorCode": "SOLVER_FAILED"})
                    return
                if len(completed.stdout) > MAX_HTTP_RESPONSE_BYTES:
                    self._reply(500, {"status": "error", "message": "Result exceeds response limit"})
                    return
                result = json.loads(completed.stdout)
                self._reply(200, {"status": "success", "result": result,
                                  "geojson": result_features(result), "solverDurationMs": duration_ms,
                                  "modelType": "TEST MODEL", "sainsModelStatus": "NOT_READY"})
            except subprocess.TimeoutExpired:
                self._reply(504, {"status": "error", "message": "Reference solver timeout", "errorCode": "TIMEOUT"})
            except (ValueError, UnicodeDecodeError):
                self._reply(400, {"status": "error", "message": "Invalid reference request"})
            return
        if urlsplit(self.path).path != "/v1/jobs":
            self._reply(404, {"status": "error", "message": "Unknown staging endpoint"})
            return
        try:
            requester = self._requester()
            size = int(self.headers.get("Content-Length", "-1"))
            if size < 0 or size > MAX_HTTP_REQUEST_BYTES:
                self._reply(413, {"status": "error", "message": "Request size limit"})
                return
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict) or set(data) - {"modelId", "scenario", "settings"}:
                raise ValueError("Malformed reference request")
            model = get_reference_model(data.get("modelId"))
            scenario = validate_scenario(data.get("scenario"))
            settings = data.get("settings") or {"durationSeconds": 0}
            if settings != {"durationSeconds": 0}:
                raise ValueError("Only static reference test is enabled")
            job = self.server.store.submit(model, scenario, requested_by=requester, settings=settings)
            correlation = self.headers.get("X-Correlation-ID", "")
            if not re.fullmatch(r"[0-9a-f-]{36}", correlation):
                correlation = None
            print(json.dumps({"event": "job_submitted", "jobId": job["jobId"],
                              "correlationId": correlation, "reused": job["reused"]}), flush=True)
            self._reply(202, {"status": "success", "job": job, "modelType": "TEST MODEL",
                              "sainsModelStatus": "NOT_READY"})
        except (ValueError, UnicodeDecodeError) as exc:
            self._reply(400, {"status": "error", "message": str(exc)[:180]})
        except RuntimeError:
            self._reply(429, {"status": "error", "message": "Staging job limit reached"})


def main():
    if os.environ.get("SAINS_STAGING_ENV") != "STAGING":
        raise SystemExit("SAINS_STAGING_ENV=STAGING is required")
    token = os.environ.get("SAINS_STAGING_SERVICE_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("A 32+ character private service token is required")
    raw_db = os.environ.get("SAINS_STAGING_DB", "")
    if not raw_db or not Path(raw_db).is_absolute():
        raise SystemExit("SAINS_STAGING_DB must be an isolated absolute path")
    db_path = Path(raw_db).resolve()
    if not db_path.parent.is_dir():
        raise SystemExit("Staging database parent does not exist")
    port = int(os.environ.get("SAINS_STAGING_PORT", "8765"))
    if not 1024 <= port <= 65535:
        raise SystemExit("Staging port outside allowed range")
    store = DurableTestJobStore(db_path)
    bind_host = "0.0.0.0" if os.environ.get("SAINS_CONTAINER_MODE") == "1" else "127.0.0.1"
    server = StagingHTTPServer((bind_host, port), token, store)
    print(json.dumps({"event": "staging_service_started", "listen": f"{bind_host}:{port}",
                      "database": str(db_path), "model": REFERENCE_MODEL["id"]}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
