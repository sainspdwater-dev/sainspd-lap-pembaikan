import math
import http.client
import json
import os
import threading
import unittest
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

from service import HydraulicSimulationService, ModelNotReady
from jobs import LocalTestJobRunner
from calibration import compare_observations
from durable_jobs import DurableTestJobStore
from staging_server import StagingHTTPServer


def test_model(loop=False):
    # Explicitly synthetic TEST DATA. Not SAINS asset parameters.
    model = {
        "id": "TEST-LOOP" if loop else "TEST-SINGLE", "version": 1,
        "validationStatus": "EXPERIMENTAL", "calibrationStatus": "UNCALIBRATED",
        "assumptions": [],
        "sources": [{"id": "R", "headM": 100.0, "source": "TEST_DATA", "effectiveAt": "2026-01-01T00:00:00Z"}],
        "nodes": [{"id": "J1", "elevationM": 20.0, "demandM3s": 0.01,
                   "demandSource": "TEST_DATA", "allocationMethod": "MANUAL_TEST"}],
        "pipes": [{"id": "P1", "start": "R", "end": "J1", "lengthM": 1000.0,
                   "diameterMm": 200.0, "roughness": 120.0,
                   "roughnessEquation": "HAZEN_WILLIAMS", "roughnessSource": "TEST_DATA",
                   "lengthSource": "TEST_DATA"}],
    }
    if loop:
        model["nodes"].append({"id": "J2", "elevationM": 25.0, "demandM3s": 0.005,
                               "demandSource": "TEST_DATA", "allocationMethod": "MANUAL_TEST"})
        model["pipes"] += [
            {**model["pipes"][0], "id": "P2", "start": "J1", "end": "J2", "lengthM": 700.0},
            {**model["pipes"][0], "id": "P3", "start": "R", "end": "J2", "lengthM": 900.0},
        ]
    return model


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.service = HydraulicSimulationService()

    def test_container_reference_solver_http_is_test_only(self):
        token = 'TEST_ONLY_CONTAINER_TOKEN_01234567890123456789'
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'SAINS_CONTAINER_MODE': '1'}):
            store = DurableTestJobStore(Path(temporary) / 'jobs.sqlite')
            server = StagingHTTPServer(('127.0.0.1', 0), token, store)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def call(model_id, credential=token):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=40)
                    connection.request('POST', '/v1/solve', json.dumps({'modelId': model_id}).encode(),
                                       {'Content-Type': 'application/json', 'X-Sains-Simulation-Token': credential})
                    reply = connection.getresponse()
                    status, body = reply.status, json.loads(reply.read())
                    connection.close()
                    return status, body

                status, body = call('TEST-REFERENCE-LOOP')
                self.assertEqual(status, 200)
                self.assertEqual(body['modelType'], 'TEST MODEL')
                self.assertAlmostEqual(body['result']['summary']['minimumPressureM'], 74.59948, delta=.02)
                self.assertEqual(len(body['geojson']['features']), 5)
                self.assertEqual(call('SAINS-PRODUCTION')[0], 400)
                self.assertEqual(call('TEST-REFERENCE-LOOP', 'wrong')[0], 401)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_single_pipe_against_independent_hazen_williams(self):
        result = self.service.runBaseline(test_model())
        q, length, diameter, c = .01, 1000, .2, 120
        expected_headloss = 10.67 * length * q**1.852 / (c**1.852 * diameter**4.871)
        self.assertAlmostEqual(result["nodes"]["J1"]["pressureM"], 100-20-expected_headloss, delta=.1)
        self.assertAlmostEqual(result["links"]["P1"]["flowM3s"], q, delta=1e-5)
        self.assertAlmostEqual(result["links"]["P1"]["velocityMs"], q/(math.pi*diameter**2/4), delta=1e-4)
        self.assertAlmostEqual(result["links"]["P1"]["headlossMperM"], expected_headloss/length, delta=.0001)
        self.assertEqual(result["engineVersion"], "EPANET 2.2.0")

    def test_scenarios_are_virtual_and_comparable(self):
        model=test_model(loop=True)
        base=self.service.runBaseline(model)
        closed=self.service.runScenario(model,{"type":"PIPE_CLOSED","targetId":"P3"})
        higher=self.service.runScenario(model,{"type":"DEMAND_CHANGE","targetId":"J2","factor":1.5})
        leak=self.service.runScenario(model,{"type":"LEAK_EMITTER","targetId":"J2","coefficient":0.001})
        # Locked EPANET 2.2.0 synthetic-network regression baseline (metres).
        # This is not an independently certified SAINS engineering model.
        self.assertAlmostEqual(base["summary"]["minimumPressureM"],74.59948,delta=.02)
        self.assertAlmostEqual(closed["summary"]["minimumPressureM"],73.25327,delta=.02)
        self.assertAlmostEqual(higher["summary"]["minimumPressureM"],74.44798,delta=.02)
        self.assertAlmostEqual(leak["summary"]["minimumPressureM"],74.02007,delta=.02)
        self.assertLess(closed["nodes"]["J2"]["pressureM"],base["nodes"]["J2"]["pressureM"])
        self.assertGreater(higher["links"]["P3"]["flowM3s"],base["links"]["P3"]["flowM3s"])
        self.assertGreater(leak["nodes"]["J2"]["demandM3s"],base["nodes"]["J2"]["demandM3s"])
        comparison=self.service.compareScenarios(base,closed,higher)
        self.assertEqual(len(comparison["scenarios"]),2)
        self.assertEqual(model["pipes"][2].get("status"),None)

    def test_missing_parameter_or_source_blocks_solver(self):
        model=test_model()
        del model["pipes"][0]["roughness"]
        with self.assertRaises(ModelNotReady): self.service.runBaseline(model)
        model=test_model()
        model["sources"]=[]
        with self.assertRaises(ModelNotReady): self.service.runBaseline(model)

    def test_disconnected_demand_blocks_solver(self):
        model=test_model(loop=True)
        model["pipes"]=[model["pipes"][0]]
        with self.assertRaises(ModelNotReady): self.service.runBaseline(model)

    def test_async_test_job_and_cache_are_version_bound(self):
        runner=LocalTestJobRunner(workers=1,max_jobs=2)
        try:
            model=test_model()
            job_id=runner.submit(model)
            runner.jobs[job_id]["future"].result(timeout=10)
            first=runner.get(job_id)
            self.assertEqual(first["status"],"COMPLETED")
            self.assertIsNotNone(first["result"])
            repeat_id=runner.submit(model)
            runner.jobs[repeat_id]["future"].result(timeout=10)
            self.assertTrue(runner.get(repeat_id)["cacheHit"])
            model["version"]=2
            newer_id=runner.submit(model)
            runner.jobs[newer_id]["future"].result(timeout=10)
            self.assertFalse(runner.get(newer_id)["cacheHit"])
        finally:
            runner.close()

    def test_calibration_excludes_test_data_and_requires_time_match(self):
        simulated=[{"dma":"DMA-A","sensorId":"CP-1","parameter":"PRESSURE","timestamp":"2026-01-01T00:00:00Z","value":30.0,"unit":"m","modelId":"M","modelVersion":1}]
        observations=[{"dma":"DMA-A","sensorId":"CP-1","parameter":"PRESSURE","timestamp":"2026-01-01T00:01:00Z","value":32.0,"unit":"m","qualityStatus":"MEASURED","isTestData":False},
                      {"dma":"PHASE2A_RELEASE_TEST","sensorId":"CP-1","parameter":"PRESSURE","timestamp":"2026-01-01T00:00:00Z","value":50.0,"unit":"m","qualityStatus":"MEASURED","isTestData":True},
                      {"dma":"DMA-A","sensorId":"CP-1","parameter":"PRESSURE","timestamp":"2026-01-01T02:00:00Z","value":20.0,"unit":"m","qualityStatus":"MEASURED","isTestData":False}]
        comparison=compare_observations(observations,simulated)
        self.assertEqual(len(comparison["matched"]),1)
        self.assertEqual(comparison["matched"][0]["residual"],2.0)
        self.assertEqual(comparison["metrics"][0]["rmse"],2.0)

    def test_durable_job_survives_restart_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'jobs.sqlite'
            first=DurableTestJobStore(path)
            submitted=first.submit(test_model(),requested_by='admin-test')
            self.assertFalse(submitted['reused'])
            same=first.submit(test_model(),requested_by='admin-test')
            self.assertEqual(same['jobId'],submitted['jobId'])
            self.assertTrue(same['reused'])
            completed=first.process_one()
            self.assertEqual(completed['status'],'COMPLETED')
            restarted=DurableTestJobStore(path)
            loaded=restarted.get(submitted['jobId'],requested_by='admin-test')
            self.assertEqual(loaded['summary'],completed['summary'])
            self.assertIsNotNone(loaded['result'])
            with self.assertRaises(PermissionError):restarted.get(submitted['jobId'],requested_by='other')
            newer=test_model();newer['version']=2
            self.assertNotEqual(restarted.submit(newer,requested_by='admin-test')['jobId'],submitted['jobId'])

    def test_durable_interrupted_job_recovery_and_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'jobs.sqlite'
            store=DurableTestJobStore(path)
            job=store.submit(test_model(),requested_by='admin-test')['jobId']
            db=sqlite3.connect(path)
            try:
                db.execute("UPDATE jobs SET status='RUNNING',attempts=1,lease_until='2000-01-01T00:00:00+00:00' WHERE id=?",(job,))
                db.commit()
            finally:
                db.close()
            restarted=DurableTestJobStore(path)
            self.assertEqual(restarted.recover_stale(),1)
            self.assertEqual(restarted.get(job)['status'],'QUEUED')
            self.assertEqual(restarted.process_one()['status'],'COMPLETED')
            another=test_model();another['version']=2
            queued=restarted.submit(another,requested_by='admin-test')['jobId']
            self.assertTrue(restarted.cancel(queued,requested_by='admin-test'))
            self.assertEqual(restarted.get(queued)['status'],'CANCELLED')

    def test_durable_solver_error_and_timeout_do_not_fabricate_result(self):
        with tempfile.TemporaryDirectory() as directory:
            failed=DurableTestJobStore(Path(directory)/'failed.sqlite')
            job=failed.submit(test_model(),{'type':'PIPE_CLOSED','targetId':'NO_SUCH_PIPE'},requested_by='admin-test')['jobId']
            result=failed.process_one()
            self.assertEqual(result['status'],'FAILED')
            self.assertIsNone(result['result'])
            self.assertEqual(result['error_code'],'SOLVER_ERROR')
            slow=DurableTestJobStore(Path(directory)/'slow.sqlite',runner=Path(__file__).with_name('test_timeout_worker.py'),timeout_seconds=.05)
            slow.submit(test_model(),requested_by='admin-test')
            timeout=slow.process_one()
            self.assertEqual(timeout['status'],'FAILED')
            self.assertEqual(timeout['error_code'],'TIMEOUT')
            self.assertIsNone(timeout['summary'])

    def test_durable_unavailable_runner_and_invalid_model_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            unavailable=DurableTestJobStore(Path(directory)/'unavailable.sqlite',
                runner=Path(directory)/'no-such-simulation-service.py')
            with self.assertRaises(ValueError):
                unavailable.submit({**test_model(),'id':'SAINS-OPERATIONS'},requested_by='admin-test')
            with self.assertRaises(ValueError):
                invalid=test_model()
                invalid['pipes'][0]['diameterMm']=0
                unavailable.submit(invalid,requested_by='admin-test')
            unavailable.submit(test_model(),requested_by='admin-test')
            result=unavailable.process_one()
            self.assertEqual(result['status'],'FAILED')
            self.assertEqual(result['error_code'],'SOLVER_ERROR')
            self.assertIsNone(result['summary'])
            self.assertIsNone(result['result'])


if __name__ == "__main__":
    unittest.main()
