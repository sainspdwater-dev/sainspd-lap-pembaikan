"""Small explicitly fictional reference network. Never a SAINS asset/model."""
from copy import deepcopy

REFERENCE_MODEL = {
    "id": "TEST-REFERENCE-LOOP", "version": 1,
    "validationStatus": "EXPERIMENTAL", "calibrationStatus": "UNCALIBRATED",
    "assumptions": [],
    "sources": [{"id": "R", "headM": 100.0, "source": "REFERENCE_TEST_DATA",
                 "effectiveAt": "2026-01-01T00:00:00Z"}],
    "nodes": [
        {"id": "J1", "elevationM": 20.0, "demandM3s": 0.01,
         "demandSource": "REFERENCE_TEST_DATA", "allocationMethod": "REFERENCE_FIXTURE"},
        {"id": "J2", "elevationM": 25.0, "demandM3s": 0.005,
         "demandSource": "REFERENCE_TEST_DATA", "allocationMethod": "REFERENCE_FIXTURE"},
    ],
    "pipes": [
        {"id": "P1", "start": "R", "end": "J1", "lengthM": 1000.0,
         "diameterMm": 200.0, "roughness": 120.0, "roughnessEquation": "HAZEN_WILLIAMS",
         "roughnessSource": "REFERENCE_TEST_DATA", "lengthSource": "REFERENCE_TEST_DATA"},
        {"id": "P2", "start": "J1", "end": "J2", "lengthM": 700.0,
         "diameterMm": 200.0, "roughness": 120.0, "roughnessEquation": "HAZEN_WILLIAMS",
         "roughnessSource": "REFERENCE_TEST_DATA", "lengthSource": "REFERENCE_TEST_DATA"},
        {"id": "P3", "start": "R", "end": "J2", "lengthM": 900.0,
         "diameterMm": 200.0, "roughness": 120.0, "roughnessEquation": "HAZEN_WILLIAMS",
         "roughnessSource": "REFERENCE_TEST_DATA", "lengthSource": "REFERENCE_TEST_DATA"},
    ],
}

# At the equator, away from SAINS operational geometry. Never show this without
# a "TEST MODEL" label. Coordinates exist only to exercise Leaflet rendering.
REFERENCE_POINTS = {"R": [0.0, 0.0], "J1": [0.008, 0.0], "J2": [0.004, 0.006]}


def get_reference_model(model_id):
    if model_id != REFERENCE_MODEL["id"]:
        raise ValueError("Only TEST-REFERENCE-LOOP is enabled")
    return deepcopy(REFERENCE_MODEL)


def result_features(result):
    if result.get("modelId") != REFERENCE_MODEL["id"]:
        raise ValueError("No operational geometry may enter reference layer")
    features = []
    for node_id, coord in REFERENCE_POINTS.items():
        if node_id not in result["nodes"]:
            continue  # reservoir head is not a reported junction pressure
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coord},
                         "properties": {"kind": "TEST_NODE", "id": node_id,
                                        **result["nodes"][node_id]}})
    for pipe in REFERENCE_MODEL["pipes"]:
        features.append({"type": "Feature", "geometry": {"type": "LineString",
                         "coordinates": [REFERENCE_POINTS[pipe["start"]], REFERENCE_POINTS[pipe["end"]]]},
                         "properties": {"kind": "TEST_LINK", "id": pipe["id"],
                                        **result["links"][pipe["id"]]}})
    return {"type": "FeatureCollection", "features": features,
            "modelType": "TEST MODEL", "coordinateDisclaimer": "Fictional coordinates, not SAINS assets"}
