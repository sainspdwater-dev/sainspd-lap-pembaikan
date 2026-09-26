"""Observation comparison only; it never mutates/calibrates model parameters."""
from __future__ import annotations

import math
from datetime import datetime, timezone


def _time(value):
    if not isinstance(value, str):
        raise ValueError("timestamp required")
    time = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if time.tzinfo is None:
        raise ValueError("timezone required")
    return time.astimezone(timezone.utc)


def compare_observations(observations, simulated, *, max_time_difference_seconds=300, include_test=False):
    """Match by sensor, parameter and time; residual = observed - simulated.

    `simulated` records must have explicit model version, time, mapped sensor ID
    and parameter. No nearest-time guess beyond the supplied tolerance.
    """
    if not 0 <= max_time_difference_seconds <= 3600:
        raise ValueError("invalid alignment tolerance")
    comparisons = []
    for obs in observations:
        if obs.get("isTestData") and not include_test or obs.get("qualityStatus") != "MEASURED":
            continue
        if obs.get("dma") == "PHASE2A_RELEASE_TEST" and not include_test:
            continue
        if not obs.get("sensorId") or obs.get("sensorId") == "DMA_UNSPECIFIED":
            continue
        observed = obs.get("value")
        if not isinstance(observed, (int,float)) or not math.isfinite(observed):
            continue
        candidates = [s for s in simulated if s.get("sensorId") == obs["sensorId"]
                      and s.get("parameter") == obs.get("parameter") and s.get("dma") == obs.get("dma")
                      and s.get("modelId") and s.get("modelVersion") is not None]
        if not candidates:
            continue
        at = _time(obs["timestamp"])
        candidate = min(candidates, key=lambda s: abs((_time(s["timestamp"])-at).total_seconds()))
        delta = abs((_time(candidate["timestamp"])-at).total_seconds())
        if delta > max_time_difference_seconds:
            continue
        value = candidate.get("value")
        if not isinstance(value,(int,float)) or not math.isfinite(value) or candidate.get("unit") != obs.get("unit"):
            continue
        comparisons.append({"dma":obs["dma"],"sensorId":obs["sensorId"],"parameter":obs["parameter"],
                            "observationTimestamp":obs["timestamp"],"simulationTimestamp":candidate["timestamp"],
                            "timeDifferenceSeconds":delta,"modelId":candidate["modelId"],"modelVersion":candidate["modelVersion"],
                            "unit":obs["unit"],"observed":float(observed),"simulated":float(value),
                            "residual":float(observed-value),"qualityStatus":obs["qualityStatus"]})
    grouped = {}
    for row in comparisons:
        key=(row["modelId"],row["modelVersion"],row["parameter"])
        grouped.setdefault(key,[]).append(row)
    metrics=[]
    for (model_id,version,parameter),rows in grouped.items():
        residuals=[r["residual"] for r in rows]
        metrics.append({"modelId":model_id,"modelVersion":version,"parameter":parameter,
                        "count":len(rows),"mae":sum(abs(r) for r in residuals)/len(rows),
                        "rmse":math.sqrt(sum(r*r for r in residuals)/len(rows)),
                        "bias":sum(residuals)/len(rows),
                        "observationStart":min(r["observationTimestamp"] for r in rows),
                        "observationEnd":max(r["observationTimestamp"] for r in rows)})
    return {"matched":comparisons,"metrics":metrics,"excludedOrUnmatched":len(observations)-len(comparisons)}
