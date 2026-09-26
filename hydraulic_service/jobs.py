"""Bounded local/test job runner. Production needs a durable private queue.

This runner is deliberately in-process: restart loses jobs, so it must not be
advertised as production infrastructure. D1 job schema stores durable metadata
once a reviewed private deployment/queue is provided.
"""
from __future__ import annotations

import concurrent.futures
import copy
import threading
import uuid
from datetime import datetime, timezone

from service import HydraulicSimulationService, canonical_hash, ENGINE_VERSION


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class LocalTestJobRunner:
    def __init__(self, *, workers=2, max_jobs=4):
        if not 1 <= workers <= 2 or not workers <= max_jobs <= 8:
            raise ValueError("Job limits outside test bounds")
        self.service = HydraulicSimulationService()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
        self.max_jobs = max_jobs
        self.jobs = {}
        self.cache = {}
        self.lock = threading.Lock()

    def submit(self, model, scenario=None, *, requested_by="TEST"):
        if not isinstance(requested_by, str) or not requested_by:
            raise ValueError("requester required")
        # Capture immutable input at submission; never allow later mutation to
        # change the model version used by a queued simulation.
        model = copy.deepcopy(model)
        scenario = copy.deepcopy(scenario)
        report = self.service.validateModel(model)
        if not report["ready"]:
            raise ValueError("Model NOT READY: " + "; ".join(report["issues"]))
        cache_key = canonical_hash({"model": model, "scenario": scenario})
        with self.lock:
            running = sum(j["status"] in {"QUEUED", "RUNNING"} for j in self.jobs.values())
            if running >= self.max_jobs:
                raise RuntimeError("Simulation job limit reached")
            job_id = str(uuid.uuid4())
            job = {"simulationId": job_id, "modelId": model["id"], "modelVersion": model["version"],
                   "scenario": scenario, "requestedBy": requested_by, "createdAt": utc_now(),
                   "startedAt": None, "completedAt": None, "status": "QUEUED", "engineVersion": ENGINE_VERSION,
                   "inputSha256": cache_key, "result": None, "error": None, "cacheHit": False}
            self.jobs[job_id] = job
            future = self.executor.submit(self._execute, job_id, model, scenario, cache_key)
            job["future"] = future
        return job_id

    def _execute(self, job_id, model, scenario, cache_key):
        with self.lock:
            job = self.jobs[job_id]
            if job["status"] == "CANCELLED":
                return
            job["status"] = "RUNNING"
            job["startedAt"] = utc_now()
            cached = self.cache.get(cache_key)
        try:
            result = copy.deepcopy(cached) if cached is not None else (
                self.service.runScenario(model, scenario) if scenario else self.service.runBaseline(model))
            with self.lock:
                self.cache.setdefault(cache_key, copy.deepcopy(result))
                job["result"] = result
                job["cacheHit"] = cached is not None
                job["status"] = "COMPLETED"
        except Exception as exc:
            with self.lock:
                job["status"] = "FAILED"
                job["error"] = {"code": type(exc).__name__, "message": str(exc)[:500]}
        finally:
            with self.lock:
                job["completedAt"] = utc_now()

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return None
            return {k: copy.deepcopy(v) for k, v in job.items() if k != "future"}

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job["status"] != "QUEUED":
                return False
            if not job["future"].cancel():
                return False
            job["status"] = "CANCELLED"
            job["completedAt"] = utc_now()
            return True

    def close(self):
        self.executor.shutdown(wait=True)
