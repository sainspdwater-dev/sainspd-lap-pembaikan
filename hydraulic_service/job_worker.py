"""Isolated one-job EPANET process; JSON stdin/stdout, explicit TEST-only gate."""
import json
import sys

from service import HydraulicSimulationService, canonical_hash


def main():
    raw=sys.stdin.buffer.read(1_048_577)
    if len(raw)>1_048_576:
        raise ValueError("Simulation input exceeds 1 MiB")
    request=json.loads(raw)
    model=request.get("model")
    if request.get("testMode") is not True or not isinstance(model,dict) or not str(model.get("id","")).startswith("TEST-"):
        raise ValueError("Only explicitly labelled non-operational TEST models are allowed")
    service=HydraulicSimulationService()
    scenario=request.get("scenario")
    result=service.runScenario(model,scenario) if scenario else service.runBaseline(model)
    result["scenarioId"]="BASELINE" if scenario is None else canonical_hash(scenario)[:12]
    output=json.dumps(result,allow_nan=False,separators=(",",":"))
    if len(output.encode())>1_048_576:
        raise ValueError("Simulation output exceeds 1 MiB")
    sys.stdout.write(output)


if __name__=="__main__":
    try:main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}",file=sys.stderr)
        raise SystemExit(2)
