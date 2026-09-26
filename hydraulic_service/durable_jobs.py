"""SQLite-backed, bounded TEST-only jobs with crash/retry persistence.

The on-disk database must live on a durable private volume. This local proof
does not establish a Cloudflare production hosting, auth or Worker bridge.
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from service import HydraulicSimulationService, ENGINE_VERSION, ALLOWED_SCENARIOS, canonical_hash

MAX_INPUT_BYTES=1_048_576
MAX_OUTPUT_BYTES=1_048_576
MAX_ACTIVE_JOBS=4
MAX_ATTEMPTS=2


def now():
    return datetime.now(timezone.utc).isoformat()


class DurableTestJobStore:
    def __init__(self,path,*,runner=None,timeout_seconds=30):
        self.path=str(Path(path).resolve())
        self.runner=str(Path(runner or Path(__file__).with_name('job_worker.py')).resolve())
        if not 0.01<=timeout_seconds<=120:raise ValueError('timeout outside bounds')
        self.timeout_seconds=timeout_seconds
        with self._connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, requested_by TEXT NOT NULL,
              model_id TEXT NOT NULL, model_version INTEGER NOT NULL,
              request_hash TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
              created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
              lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
              engine_version TEXT NOT NULL, result_json TEXT, summary_json TEXT,
              warnings_json TEXT, error_code TEXT, error_message TEXT,
              queue_delay_ms REAL, solver_duration_ms REAL, persistence_duration_ms REAL);
              CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status,created_at);''')
            present={row['name'] for row in db.execute('PRAGMA table_info(jobs)')}
            for name in ('queue_delay_ms','solver_duration_ms','persistence_duration_ms'):
                if name not in present:
                    db.execute(f'ALTER TABLE jobs ADD COLUMN {name} REAL')

    @contextmanager
    def _connect(self):
        db=sqlite3.connect(self.path,timeout=10)
        try:
            db.row_factory=sqlite3.Row
            db.execute('PRAGMA busy_timeout=10000')
            db.execute('PRAGMA journal_mode=WAL')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def submit(self,model,scenario=None,*,requested_by,owner_scope='TEST',settings=None):
        if not requested_by or not owner_scope:raise ValueError('requester and scope required')
        if owner_scope!='TEST' or not str(model.get('id','')).startswith('TEST-'):
            raise ValueError('Only non-operational TEST model submissions are enabled')
        report=HydraulicSimulationService().validateModel(model)
        if not report['ready']:raise ValueError('Model NOT READY: '+'; '.join(report['issues']))
        if scenario is not None and (not isinstance(scenario,dict) or scenario.get('type') not in ALLOWED_SCENARIOS):
            raise ValueError('Scenario type not allowed')
        if settings is not None and settings!={'durationSeconds':0}:
            raise ValueError('Only static test simulations are supported')
        payload={'model':model,'scenario':scenario,'settings':settings or {'durationSeconds':0},'testMode':True}
        encoded=json.dumps(payload,sort_keys=True,separators=(',',':'),allow_nan=False)
        if len(encoded.encode())>MAX_INPUT_BYTES:raise ValueError('input exceeds 1 MiB')
        request_hash=canonical_hash({'scope':owner_scope,'payload':payload})
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing=db.execute('SELECT id,status FROM jobs WHERE request_hash=?',(request_hash,)).fetchone()
            if existing:return {'jobId':existing['id'],'reused':True,'status':existing['status']}
            active=db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('QUEUED','RUNNING')").fetchone()[0]
            if active>=MAX_ACTIVE_JOBS:raise RuntimeError('simulation job limit reached')
            job_id=str(uuid.uuid4())
            db.execute('''INSERT INTO jobs(id,owner_scope,requested_by,model_id,model_version,request_hash,
              input_json,status,created_at,engine_version) VALUES(?,?,?,?,?,?,?,?,?,?)''',
              (job_id,owner_scope,requested_by,model['id'],model['version'],request_hash,encoded,'QUEUED',now(),ENGINE_VERSION))
            return {'jobId':job_id,'reused':False,'status':'QUEUED'}

    def recover_stale(self):
        current=now()
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            stale=db.execute("SELECT id,attempts FROM jobs WHERE status='RUNNING' AND (lease_until IS NULL OR lease_until<?)",(current,)).fetchall()
            for job in stale:
                if job['attempts']>=MAX_ATTEMPTS:
                    db.execute("UPDATE jobs SET status='FAILED',completed_at=?,error_code='INTERRUPTED',error_message='Worker lease expired' WHERE id=?",(current,job['id']))
                else:
                    db.execute("UPDATE jobs SET status='QUEUED',started_at=NULL,lease_until=NULL,error_code='RETRY_AFTER_INTERRUPTION' WHERE id=?",(job['id'],))
        return len(stale)

    def process_one(self):
        self.recover_stale()
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job=db.execute("SELECT id,input_json,attempts,created_at FROM jobs WHERE status='QUEUED' ORDER BY created_at,id LIMIT 1").fetchone()
            if not job:return None
            lease=(datetime.now(timezone.utc)+timedelta(seconds=max(60,self.timeout_seconds+30))).isoformat()
            started_at=now()
            queue_delay_ms=(datetime.fromisoformat(started_at)-datetime.fromisoformat(job['created_at'])).total_seconds()*1000
            db.execute("UPDATE jobs SET status='RUNNING',started_at=?,lease_until=?,attempts=attempts+1,queue_delay_ms=? WHERE id=?",
                       (started_at,lease,queue_delay_ms,job['id']))
            job_id,payload=job['id'],job['input_json']
        status='FAILED';result_json=None;summary_json=None;warnings_json=None;error_code=None;error_message=None
        solver_started=time.perf_counter()
        try:
            completed=subprocess.run([sys.executable,self.runner],input=payload,capture_output=True,text=True,
                                     timeout=self.timeout_seconds,check=False)
            if completed.returncode:
                error_code='SOLVER_ERROR';error_message=completed.stderr[-500:] or f'exit {completed.returncode}'
            elif len(completed.stdout.encode())>MAX_OUTPUT_BYTES:
                error_code='OUTPUT_LIMIT';error_message='Solver output exceeded 1 MiB'
            else:
                result=json.loads(completed.stdout)
                expected=json.loads(payload)['model']
                if result.get('modelId') != expected['id'] or result.get('modelVersion') != expected['version'] or not isinstance(result.get('summary'),dict):
                    raise ValueError('Solver result identity/summary invalid')
                result_json=json.dumps(result,separators=(',',':'),allow_nan=False)
                summary_json=json.dumps(result['summary'],separators=(',',':'),allow_nan=False)
                warnings_json=json.dumps(result.get('warnings',[]),separators=(',',':'))
                status='COMPLETED'
        except subprocess.TimeoutExpired:
            error_code='TIMEOUT';error_message=f'Solver exceeded {self.timeout_seconds}s'
        except (OSError,ValueError,json.JSONDecodeError) as exc:
            error_code=type(exc).__name__;error_message=str(exc)[:500]
        solver_duration_ms=(time.perf_counter()-solver_started)*1000
        persistence_started=time.perf_counter()
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('''UPDATE jobs SET status=?,completed_at=?,lease_until=NULL,result_json=?,summary_json=?,
              warnings_json=?,error_code=?,error_message=?,solver_duration_ms=? WHERE id=? AND status='RUNNING' ''',
              (status,now(),result_json,summary_json,warnings_json,error_code,error_message,solver_duration_ms,job_id))
        persistence_duration_ms=(time.perf_counter()-persistence_started)*1000
        with self._connect() as db:
            db.execute('UPDATE jobs SET persistence_duration_ms=? WHERE id=?',(persistence_duration_ms,job_id))
        return self.get(job_id)

    def get(self,job_id,*,requested_by=None,include_result=True):
        with self._connect() as db:
            row=db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
        if row is None:return None
        if requested_by is not None and requested_by!=row['requested_by']:raise PermissionError('job owner mismatch')
        result={k:row[k] for k in row.keys() if k not in {'input_json','result_json','summary_json','warnings_json'}}
        result['summary']=json.loads(row['summary_json']) if row['summary_json'] else None
        result['warnings']=json.loads(row['warnings_json']) if row['warnings_json'] else []
        result['result']=json.loads(row['result_json']) if include_result and row['result_json'] else None
        return result

    def cancel(self,job_id,*,requested_by):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            changed=db.execute("UPDATE jobs SET status='CANCELLED',completed_at=? WHERE id=? AND requested_by=? AND status='QUEUED'",(now(),job_id,requested_by)).rowcount
        return bool(changed)

    def latest_completed(self,*,requested_by,model_id):
        with self._connect() as db:
            row=db.execute("""SELECT id FROM jobs WHERE requested_by=? AND model_id=?
                AND status='COMPLETED' ORDER BY completed_at DESC,id DESC LIMIT 1""",
                (requested_by,model_id)).fetchone()
        return self.get(row['id'],requested_by=requested_by) if row else None
