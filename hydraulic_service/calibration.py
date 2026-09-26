"""Observation comparison only; it never mutates/calibrates model parameters."""
from __future__ import annotations

import math
from datetime import datetime, timezone

ALLOWED_SOURCES = {"SCADA_CSV", "MANUAL"}
CALIBRATION_PARAMETERS = {"FLOW", "INLET_PRESSURE", "CP_PRESSURE"}
TEST_MARKERS = {"PHASE2A_RELEASE_TEST", "PHASE2BS_REFERENCE_TEST", "PHASE2A_TEST"}


def _time(value):
    if not isinstance(value, str):
        raise ValueError("timestamp required")
    time = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if time.tzinfo is None:
        raise ValueError("timezone required")
    return time.astimezone(timezone.utc)


def normalize_phase2a_observation(row):
    """Accept only measured, non-test normalized Phase 2A D1 observation rows.

    No unit conversion is inferred. Simulated channels must be explicitly
    mapped to the same DMA, sensor, parameter, timestamp and unit.
    """
    source = row.get("source")
    dma = row.get("district_metered_area", row.get("dma"))
    sensor = row.get("sensor_id", row.get("sensorId"))
    parameter = row.get("parameter")
    quality = row.get("quality_status", row.get("qualityStatus"))
    measured = row.get("timestamp_provenance", "MEASURED") == "MEASURED"
    timestamp = row.get("recorded_at", row.get("timestamp"))
    batch = row.get("import_batch_id", "") or ""
    remark = row.get("remark", "") or ""
    if source not in ALLOWED_SOURCES or quality not in {"VALID", "MEASURED"} or not measured:
        return None
    if row.get("isTestData") or dma in TEST_MARKERS or "TEST DATA" in remark.upper() or "TEST" in batch.upper():
        return None
    if parameter not in CALIBRATION_PARAMETERS or not dma or not sensor or sensor == "DMA_UNSPECIFIED":
        return None
    value = row.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    unit = row.get("unit")
    if unit != ("m3/h" if parameter == "FLOW" else "bar"):
        return None
    try:
        _time(timestamp)
    except (ValueError, TypeError):
        return None
    return {"dma": dma, "sensorId": sensor, "parameter": parameter, "timestamp": timestamp,
            "value": float(value), "unit": unit, "qualityStatus": "MEASURED", "source": source,
            "isTestData": False, "observationUid": row.get("observation_uid")}


def build_simulated_observations(result, mappings, *, model_timestamp):
    """Apply only reviewed sensor links and explicit, labelled SI conversions.

    Static EPANET time zero is not a field timestamp. The caller must supply
    the actual model boundary/snapshot time for calibration alignment.
    """
    _time(model_timestamp)
    rows = []
    for mapping in mappings:
        if mapping.get("reviewStatus") != "APPROVED" or not mapping.get("reviewedBy") or not mapping.get("sourceRef"):
            raise ValueError("approved sensor-to-model mapping required")
        parameter = mapping.get("parameter")
        entity_id = mapping.get("entityId")
        if parameter in {"INLET_PRESSURE", "CP_PRESSURE"}:
            if mapping.get("entityType") != "NODE" or mapping.get("conversionBasis") != "HEAD_M_TO_BAR_RHO1000_G9.80665":
                raise ValueError("explicit pressure conversion and node mapping required")
            value = result["nodes"][entity_id]["pressureM"] * 1000 * 9.80665 / 100000
            unit = "bar"
        elif parameter == "FLOW":
            if mapping.get("entityType") != "LINK" or mapping.get("conversionBasis") != "M3S_TO_M3H" or mapping.get("flowDirection") not in {-1, 1}:
                raise ValueError("explicit flow unit and meter direction required")
            value = result["links"][entity_id]["flowM3s"] * 3600 * mapping["flowDirection"]
            unit = "m3/h"
        else:
            raise ValueError("unsupported calibration parameter")
        rows.append({"dma": mapping["dma"], "sensorId": mapping["sensorId"], "parameter": parameter,
                     "timestamp": model_timestamp, "value": value, "unit": unit,
                     "modelId": result["modelId"], "modelVersion": result["modelVersion"],
                     "conversionBasis": mapping["conversionBasis"], "mappingSource": mapping["sourceRef"]})
    return rows


def compare_observations(observations, simulated, *, max_time_difference_seconds=300,
                         model_id=None, model_version=None):
    """Match by sensor, parameter and time; residual = observed - simulated.

    `simulated` records must have explicit model version, time, mapped sensor ID
    and parameter. No nearest-time guess beyond the supplied tolerance.
    """
    if not 0 <= max_time_difference_seconds <= 3600:
        raise ValueError("invalid alignment tolerance")
    models = {(row.get("modelId"), row.get("modelVersion")) for row in simulated}
    if model_id is not None or model_version is not None:
        models = {(model_id, model_version)}
    if len(models) != 1 or None in next(iter(models), (None, None)):
        raise ValueError("one explicit model ID and version required")
    selected_model = next(iter(models))
    comparisons, used_simulations = [], set()
    for source_row in observations:
        obs = normalize_phase2a_observation(source_row)
        if obs is None:
            continue
        observed = obs.get("value")
        candidates = [(index, s) for index, s in enumerate(simulated) if index not in used_simulations
                      and (s.get("modelId"), s.get("modelVersion")) == selected_model
                      and s.get("sensorId") == obs["sensorId"]
                      and s.get("parameter") == obs.get("parameter") and s.get("dma") == obs.get("dma")
                      and s.get("unit") == obs.get("unit")]
        if not candidates:
            continue
        at = _time(obs["timestamp"])
        candidate_index, candidate = min(candidates, key=lambda pair: (abs((_time(pair[1]["timestamp"])-at).total_seconds()), pair[0]))
        delta = abs((_time(candidate["timestamp"])-at).total_seconds())
        if delta > max_time_difference_seconds:
            continue
        value = candidate.get("value")
        if isinstance(value, bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
            continue
        used_simulations.add(candidate_index)
        comparisons.append({"dma":obs["dma"],"sensorId":obs["sensorId"],"parameter":obs["parameter"],
                            "observationTimestamp":obs["timestamp"],"simulationTimestamp":candidate["timestamp"],
                            "timeDifferenceSeconds":delta,"modelId":candidate["modelId"],"modelVersion":candidate["modelVersion"],
                            "unit":obs["unit"],"observed":float(observed),"simulated":float(value),
                            "residual":float(observed-value),"qualityStatus":obs["qualityStatus"],
                            "source":obs["source"],"observationUid":obs["observationUid"]})
    grouped = {}
    for row in comparisons:
        key=(row["modelId"],row["modelVersion"],row["parameter"])
        grouped.setdefault(key,[]).append(row)
    metrics=[]
    for (model_id,version,parameter),rows in grouped.items():
        residuals=[r["residual"] for r in rows]
        metrics.append({"modelId":model_id,"modelVersion":version,"parameter":parameter,
                        "count":len(rows),"sensorCount":len({r["sensorId"] for r in rows}),
                        "timeCoverageSeconds":(max(_time(r["observationTimestamp"]) for r in rows)-
                                               min(_time(r["observationTimestamp"]) for r in rows)).total_seconds(),
                        "unit":rows[0]["unit"],"mae":sum(abs(r) for r in residuals)/len(rows),
                        "rmse":math.sqrt(sum(r*r for r in residuals)/len(rows)),
                        "bias":sum(residuals)/len(rows),
                        "observationStart":min(r["observationTimestamp"] for r in rows),
                        "observationEnd":max(r["observationTimestamp"] for r in rows)})
    return {"matched":comparisons,"metrics":metrics,"excludedOrUnmatched":len(observations)-len(comparisons)}


def assess_calibration(comparison, *, criteria=None, reviewed_by=None, validation_comparison=None):
    """No automatic tuning and no implicit numeric acceptance thresholds.

    Criteria must be engineering-approved per parameter (minimum count/time
    coverage, MAE/RMSE/bias ceilings in that parameter's explicit unit).
    """
    metrics = {row["parameter"]: row for row in comparison["metrics"]}
    if not metrics:
        return {"status": "CALIBRATION DATA INSUFFICIENT", "reasons": ["No matched non-test observations"]}
    if not criteria:
        return {"status": "CALIBRATION IN PROGRESS", "reasons": ["Engineering acceptance criteria absent"]}
    reasons = []
    for parameter in ("FLOW", "INLET_PRESSURE", "CP_PRESSURE"):
        if parameter not in criteria:
            continue
        metric, rule = metrics.get(parameter), criteria[parameter]
        if not metric:
            reasons.append(f"{parameter}: no matched observations")
            continue
        if metric["unit"] != rule.get("unit"):
            reasons.append(f"{parameter}: unit mismatch")
        if metric["count"] < rule.get("minCount", 1) or metric["timeCoverageSeconds"] < rule.get("minCoverageSeconds", 0):
            reasons.append(f"{parameter}: observations/coverage insufficient")
        for name in ("mae", "rmse", "bias"):
            if (name not in rule or isinstance(rule[name], bool) or not isinstance(rule[name], (int, float)) or
                    not math.isfinite(rule[name]) or rule[name] < 0):
                reasons.append(f"{parameter}: approved {name} threshold missing")
            elif (abs(metric[name]) if name == "bias" else metric[name]) > rule[name]:
                reasons.append(f"{parameter}: {name} outside approved limit")
    if "FLOW" not in criteria or not criteria.keys() & {"INLET_PRESSURE", "CP_PRESSURE"}:
        reasons.append("Both flow and at least one pressure criterion are required")
    if reasons:
        return {"status": "CALIBRATION DATA INSUFFICIENT", "reasons": reasons}
    if not reviewed_by:
        return {"status": "CALIBRATION IN PROGRESS", "reasons": ["Engineering review/sign-off pending"]}
    result = {"status": "CALIBRATED", "reasons": [], "reviewedBy": reviewed_by, "criteria": criteria}
    if validation_comparison is not None:
        training_ids = {row.get("observationUid") for row in comparison["matched"]}
        validation_ids = {row.get("observationUid") for row in validation_comparison["matched"]}
        if None in training_ids or None in validation_ids or not validation_ids or training_ids & validation_ids:
            result["reasons"].append("Independent holdout observation IDs required")
        else:
            holdout = assess_calibration(validation_comparison, criteria=criteria, reviewed_by=reviewed_by)
            if holdout["status"] == "CALIBRATED":
                result["status"] = "VALIDATED"
            else:
                result["reasons"].append("Independent holdout did not meet approved criteria")
    return result
