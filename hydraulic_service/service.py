"""Private/test-only hydraulic service. Never expose this CLI as a public API.

Input is an explicitly reviewed model in SI units, not raw GIS. The EPA
EPANET 2.2 engine is invoked through EPA WNTR 1.5.0 outside Cloudflare Worker.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import wntr

ENGINE_VERSION = "EPANET 2.2.0"
WRAPPER_VERSION = wntr.__version__
MAX_NODES = 5000
MAX_LINKS = 10000
ALLOWED_SCENARIOS = {"PIPE_CLOSED", "DEMAND_CHANGE", "LEAK_EMITTER", "SOURCE_HEAD_CHANGE"}


class ModelNotReady(ValueError):
    pass


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def required_number(record: dict, field: str, *, positive=False, minimum=None, maximum=None) -> float:
    raw = record.get(field)
    if isinstance(raw, bool) or not isinstance(raw, (float, int)) or not math.isfinite(raw):
        raise ModelNotReady(f"{field} missing or invalid")
    value = float(raw)
    if positive and value <= 0 or minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ModelNotReady(f"{field} outside allowed bounds")
    return value


@dataclass
class HydraulicSimulationService:
    """Deterministic model builder, EPA solver runner and structured comparison."""

    pressure_min_m: float = 0.0
    pressure_max_m: float = 100.0
    velocity_max_ms: float = 3.0

    def validateModel(self, model: dict) -> dict:
        issues = []
        if not isinstance(model, dict) or model.get("validationStatus") not in {"UNCALIBRATED", "CALIBRATED", "VALIDATED", "EXPERIMENTAL"}:
            issues.append("Model version/review status is missing")
        nodes = model.get("nodes", []) if isinstance(model, dict) else []
        pipes = model.get("pipes", []) if isinstance(model, dict) else []
        sources = model.get("sources", []) if isinstance(model, dict) else []
        if not nodes or not pipes or not sources or len(nodes) > MAX_NODES or len(pipes) > MAX_LINKS:
            issues.append("Network missing or exceeds size limits")
        ids = [n.get("id") for n in nodes] + [s.get("id") for s in sources]
        if len(ids) != len(set(ids)) or any(not isinstance(i, str) or not i for i in ids):
            issues.append("Node IDs invalid or duplicated")
        for n in nodes:
            try:
                required_number(n, "elevationM", minimum=-1000, maximum=10000)
                required_number(n, "demandM3s", minimum=0, maximum=10)
                if not n.get("demandSource") or not n.get("allocationMethod"):
                    raise ModelNotReady("Demand provenance/allocation absent")
            except ModelNotReady as exc:
                issues.append(f"Node {n.get('id')}: {exc}")
        for source in sources:
            try:
                required_number(source, "headM", minimum=-1000, maximum=10000)
                if not source.get("source") or not source.get("effectiveAt"):
                    raise ModelNotReady("Source head provenance absent")
            except ModelNotReady as exc:
                issues.append(f"Source {source.get('id')}: {exc}")
        pairs = set()
        for pipe in pipes:
            label = f"Pipe {pipe.get('id')}"
            if pipe.get("start") not in ids or pipe.get("end") not in ids or pipe.get("start") == pipe.get("end"):
                issues.append(f"{label}: endpoints missing/invalid")
            try:
                required_number(pipe, "lengthM", positive=True, maximum=100000)
                required_number(pipe, "diameterMm", positive=True, maximum=5000)
                required_number(pipe, "roughness", positive=True, maximum=500)
                if pipe.get("roughnessEquation") != "HAZEN_WILLIAMS" or not pipe.get("roughnessSource") or not pipe.get("lengthSource"):
                    raise ModelNotReady("Pipe parameter provenance/equation absent")
            except ModelNotReady as exc:
                issues.append(f"{label}: {exc}")
            pair = tuple(sorted((pipe.get("start"), pipe.get("end"))))
            if pair in pairs:
                issues.append(f"{label}: parallel/duplicate edge requires explicit review")
            pairs.add(pair)
        if len({p.get("id") for p in pipes}) != len(pipes):
            issues.append("Pipe IDs duplicated")
        if any(a.get("approvalStatus") != "APPROVED" for a in model.get("assumptions", [])):
            issues.append("Unapproved assumption")
        # Physical connectivity to a supply source is essential. Pipe closure
        # scenarios are checked again after modification.
        graph = {i: set() for i in ids}
        for p in pipes:
            if p.get("start") in graph and p.get("end") in graph:
                graph[p["start"]].add(p["end"])
                graph[p["end"]].add(p["start"])
        reached = {s.get("id") for s in sources}
        frontier = list(reached)
        while frontier:
            for nxt in graph.get(frontier.pop(), ()) - reached:
                reached.add(nxt)
                frontier.append(nxt)
        if any(n.get("id") not in reached and n.get("demandM3s", 0) > 0 for n in nodes):
            issues.append("Demand node disconnected from source")
        return {"ready": not issues, "issues": issues, "nodeCount": len(nodes)+len(sources), "pipeCount": len(pipes)}

    def buildModel(self, model: dict) -> wntr.network.WaterNetworkModel:
        report = self.validateModel(model)
        if not report["ready"]:
            raise ModelNotReady("; ".join(report["issues"]))
        network = wntr.network.WaterNetworkModel()
        network.options.hydraulic.headloss = "H-W"
        network.options.time.duration = 0  # static only; no invented pattern
        for source in model["sources"]:
            network.add_reservoir(source["id"], base_head=source["headM"])
        for node in model["nodes"]:
            network.add_junction(node["id"], base_demand=node["demandM3s"], elevation=node["elevationM"])
        for pipe in model["pipes"]:
            network.add_pipe(pipe["id"], pipe["start"], pipe["end"], length=pipe["lengthM"],
                             diameter=pipe["diameterMm"]/1000, roughness=pipe["roughness"],
                             initial_status=pipe.get("status", "OPEN"))
        return network

    def _run(self, model: dict, *, scenario=None) -> dict:
        network = self.buildModel(model)
        if scenario:
            self._apply_scenario(network, scenario)
        if any(network.get_link(p["id"]).status.name == "Closed" for p in model["pipes"]):
            # Validate source connectivity after closures. Do not accept
            # EPANET's disconnected-demand warnings as valid pressures.
            open_model = copy.deepcopy(model)
            open_model["pipes"] = [p for p in model["pipes"] if network.get_link(p["id"]).status.name != "Closed"]
            if not self.validateModel(open_model)["ready"]:
                raise ModelNotReady("Scenario disconnects demand from supply")
        try:
            # WNTR creates INP/RPT/BIN files; keep sensitive network input out
            # of the public repo and remove all solver intermediates on exit.
            with tempfile.TemporaryDirectory(prefix="sains-epanet-") as scratch:
                # EPANET's C toolkit otherwise chooses its own scratch .hyd
                # filename. Point it at this per-run writable directory so a
                # non-root Container can create and remove it reliably.
                network.options.hydraulic.hydraulics = "SAVE"
                network.options.hydraulic.hydraulics_filename = str(Path(scratch)/"simulation.hyd")
                result = wntr.sim.EpanetSimulator(network).run_sim(
                    file_prefix=str(Path(scratch)/"simulation"),version=2.2,convergence_error=True)
        except Exception as exc:
            raise RuntimeError(f"EPANET_FAILED: {type(exc).__name__}: {exc}") from exc
        pressures = result.node["pressure"].iloc[0].to_dict()
        heads = result.node["head"].iloc[0].to_dict()
        demands = result.node["demand"].iloc[0].to_dict()
        flows = result.link["flowrate"].iloc[0].to_dict()
        velocities = result.link["velocity"].iloc[0].to_dict()
        headloss = result.link["headloss"].iloc[0].to_dict()
        statuses = result.link["status"].iloc[0].to_dict()
        node_rows = {n["id"]: {"pressureM": float(pressures[n["id"]]), "headM": float(heads[n["id"]]),
                               "demandM3s": float(demands[n["id"]])} for n in model["nodes"]}
        link_rows = {p["id"]: {"flowM3s": float(flows[p["id"]]), "velocityMs": float(velocities[p["id"]]),
                               "headlossMperM": float(headloss[p["id"]]), "status": int(statuses[p["id"]])} for p in model["pipes"]}
        warnings = []
        for name,row in node_rows.items():
            if row["pressureM"] < self.pressure_min_m: warnings.append(f"NEGATIVE_OR_LOW_PRESSURE:{name}")
            if row["pressureM"] > self.pressure_max_m: warnings.append(f"HIGH_PRESSURE:{name}")
        for name,row in link_rows.items():
            if abs(row["velocityMs"]) > self.velocity_max_ms: warnings.append(f"HIGH_VELOCITY:{name}")
        return {"engineVersion": ENGINE_VERSION, "wrapperVersion": WRAPPER_VERSION,
                "modelId": model["id"], "modelVersion": model["version"], "inputSha256": canonical_hash({"model":model,"scenario":scenario}),
                "validationStatus": model["validationStatus"], "calibrationStatus": model.get("calibrationStatus", "UNCALIBRATED"),
                "nodes": node_rows, "links": link_rows,
                "summary": {"minimumPressureM": min(r["pressureM"] for r in node_rows.values()),
                            "maximumPressureM": max(r["pressureM"] for r in node_rows.values()),
                            "averagePressureM": sum(r["pressureM"] for r in node_rows.values())/len(node_rows),
                            "maximumVelocityMs": max(abs(r["velocityMs"]) for r in link_rows.values()),
                            "nodesBelowThreshold": [name for name,row in node_rows.items() if row["pressureM"] < self.pressure_min_m],
                            "solverStatus": "COMPLETED"},
                "warnings": warnings}

    def _apply_scenario(self, network, scenario: dict) -> None:
        kind = scenario.get("type")
        if kind not in ALLOWED_SCENARIOS:
            raise ValueError("Scenario type not allowed")
        target = scenario.get("targetId")
        if kind == "PIPE_CLOSED":
            pipe = network.get_link(target)
            if not isinstance(pipe, wntr.network.Pipe): raise ValueError("Target is not a pipe")
            pipe.initial_status = "CLOSED"
        elif kind == "DEMAND_CHANGE":
            factor = required_number(scenario, "factor", minimum=0, maximum=3)
            node = network.get_node(target)
            if not isinstance(node, wntr.network.Junction): raise ValueError("Target is not a junction")
            node.demand_timeseries_list[0].base_value *= factor
        elif kind == "LEAK_EMITTER":
            coefficient = required_number(scenario, "coefficient", positive=True, maximum=0.1)
            node = network.get_node(target)
            if not isinstance(node, wntr.network.Junction): raise ValueError("Target is not a junction")
            node.emitter_coefficient = coefficient
        elif kind == "SOURCE_HEAD_CHANGE":
            head = required_number(scenario, "headM", minimum=-1000, maximum=10000)
            source = network.get_node(target)
            if not isinstance(source, wntr.network.Reservoir): raise ValueError("Target is not a reservoir")
            source.head_timeseries.base_value = head

    def runBaseline(self, model: dict) -> dict:
        return self._run(model)

    def runScenario(self, model: dict, scenario: dict) -> dict:
        return self._run(model, scenario=scenario)

    def compareScenarios(self, baseline: dict, *scenarios: dict) -> dict:
        if any(s["modelId"] != baseline["modelId"] or s["modelVersion"] != baseline["modelVersion"] for s in scenarios):
            raise ValueError("Cannot compare different model versions")
        return {"baseline": baseline["summary"], "scenarios": [
            {"inputSha256": s["inputSha256"], "summary": s["summary"],
             "deltaMinimumPressureM": s["summary"]["minimumPressureM"]-baseline["summary"]["minimumPressureM"],
             "nodePressureChangeM": {n:s["nodes"][n]["pressureM"]-base["pressureM"] for n,base in baseline["nodes"].items()},
             "warnings": s["warnings"]} for s in scenarios]}

    def getNodeResults(self, result: dict, node_id: str) -> dict:
        return result["nodes"][node_id]

    def getLinkResults(self, result: dict, link_id: str) -> dict:
        return result["links"][link_id]

    def getModelStatus(self, model: dict) -> dict:
        return self.validateModel(model)

    def getSimulationStatus(self, job: dict) -> str:
        return job["status"]
