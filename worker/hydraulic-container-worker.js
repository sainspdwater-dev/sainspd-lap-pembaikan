// Private, TEST-only Cloudflare Container service. No public route or workers.dev URL.
// The Durable Object is the authoritative job store; container /tmp is ephemeral.
import { Container, getContainer } from '@cloudflare/containers';

const MODEL = 'TEST-REFERENCE-LOOP';
const VERSION = 1;
const MAX_BODY = 8192;
const MAX_RESULT = 1_048_576;
const JOB_PREFIX = 'job:';
const HASH_PREFIX = 'hash:';
const VALID_USER = /^[A-Za-z0-9_.@-]{1,100}$/;
const VALID_ID = /^[0-9a-f-]{36}$/;
const iso = () => new Date().toISOString();
const response = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || b.length < 32) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
};

function validScenario(scenario) {
  if (scenario === null || scenario === undefined) return null;
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error('Malformed test scenario');
  const keys = Object.keys(scenario).sort().join(',');
  if (scenario.type === 'PIPE_CLOSED' && ['P1', 'P2', 'P3'].includes(scenario.targetId) && keys === 'targetId,type') return scenario;
  if (scenario.type === 'DEMAND_CHANGE' && ['J1', 'J2'].includes(scenario.targetId) && keys === 'factor,targetId,type' &&
      Number.isFinite(scenario.factor) && scenario.factor >= 0 && scenario.factor <= 3) return scenario;
  if (scenario.type === 'SOURCE_HEAD_CHANGE' && scenario.targetId === 'R' && keys === 'headM,targetId,type' &&
      Number.isFinite(scenario.headM) && scenario.headM >= 0 && scenario.headM <= 200) return scenario;
  throw new Error('Scenario outside reference-model scope');
}

async function hashOf(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class HydraulicReferenceContainer extends Container {
  defaultPort = 8765;
  pingEndpoint = 'localhost:8765/ping';
  sleepAfter = '5m';
  enableInternet = false;

  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.envVars = {
      SAINS_STAGING_ENV: 'STAGING', SAINS_CONTAINER_MODE: '1',
      SAINS_STAGING_SERVICE_TOKEN: env.CONTAINER_INTERNAL_TOKEN,
      SAINS_STAGING_DB: '/tmp/sains-test-ephemeral.sqlite', SAINS_STAGING_PORT: '8765'
    };
  }

  async _container(path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('X-Sains-Simulation-Token', this.env.CONTAINER_INTERNAL_TOKEN);
    headers.set('Content-Type', 'application/json');
    return this.containerFetch(`http://localhost:8765${path}`, { ...init, headers, signal: AbortSignal.timeout(45000) });
  }

  async fetch(request) {
    if (!sameSecret(request.headers.get('X-Sains-Simulation-Token'), this.env.HYDRAULIC_SERVICE_TOKEN))
      return response(401, { status: 'error', message: 'Service authentication required' });
    const requester = request.headers.get('X-Requester') || '';
    if (!VALID_USER.test(requester)) return response(403, { status: 'error', message: 'Requester required' });
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/v1/health') {
        const upstream = await this._container('/v1/health');
        if (!upstream.ok) throw new Error('CONTAINER_UNAVAILABLE');
        const health = await upstream.json();
        return response(200, { ...health, persistence: 'DURABLE_OBJECT_SQLITE', modelType: 'TEST MODEL' });
      }
      if (request.method === 'POST' && path === '/v1/jobs') return this._submit(request, requester);
      if (request.method === 'GET' && path === '/v1/jobs/latest') return this._latest(requester);
      if (request.method === 'GET' && VALID_ID.test(path.slice('/v1/jobs/'.length)) && path.startsWith('/v1/jobs/'))
        return this._get(path.slice('/v1/jobs/'.length), requester);
      return response(404, { status: 'error', message: 'Unknown private endpoint' });
    } catch (error) {
      console.log(JSON.stringify({ event: 'container_gateway_error', type: error.name }));
      return response(503, { status: 'error', message: 'Reference container unavailable' });
    }
  }

  async _submit(request, requester) {
    const length = Number(request.headers.get('Content-Length') || -1);
    if (length > MAX_BODY) return response(413, { status: 'error', message: 'Request size limit' });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return response(413, { status: 'error', message: 'Request size limit' });
    let input;
    try {
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(key => !['modelId', 'scenario', 'settings'].includes(key)) || payload.modelId !== MODEL)
        throw new Error('Only the TEST reference model is allowed');
      input = { modelId: MODEL, scenario: validScenario(payload.scenario), settings: payload.settings || { durationSeconds: 0 } };
      if (JSON.stringify(input.settings) !== '{"durationSeconds":0}') throw new Error('Only static reference simulation is allowed');
    } catch (error) {
      return response(400, { status: 'error', message: error.message.slice(0, 160) });
    }
    const input_hash = await hashOf({ requester, version: VERSION, input });
    let job, reused = false;
    await this.ctx.storage.transaction(async tx => {
      const priorId = await tx.get(HASH_PREFIX + input_hash);
      if (priorId) {
        const prior = await tx.get(JOB_PREFIX + priorId);
        if (prior && prior.status !== 'FAILED') { job = prior; reused = true; return; }
      }
      const all = await tx.list({ prefix: JOB_PREFIX });
      if ([...all.values()].filter(row => ['QUEUED', 'RUNNING'].includes(row.status)).length >= 4)
        throw new Error('LIMIT');
      const id = crypto.randomUUID();
      job = { id, model_id: MODEL, model_version: VERSION, scenario: input.scenario,
        settings: input.settings, requested_by: requester, input_hash, engine_version: 'EPANET 2.2.0',
        created_at: iso(), started_at: null, completed_at: null, status: 'QUEUED', attempts: 0,
        result: null, summary: null, geojson: null, warnings: [], error_code: null, error_message: null,
        queue_delay_ms: null, solver_duration_ms: null, persistence_duration_ms: null };
      await tx.put(JOB_PREFIX + id, job);
      await tx.put(HASH_PREFIX + input_hash, id);
    }).catch(error => { if (error.message !== 'LIMIT') throw error; });
    if (!job) return response(429, { status: 'error', message: 'Staging job limit reached' });
    if (!reused) {
      await this.schedule(1, 'executeJob', { jobId: job.id });
      await this.schedule(60, 'recoverJob', { jobId: job.id });
    }
    return response(202, { status: 'success', job: { jobId: job.id, status: job.status, reused },
      modelType: 'TEST MODEL', sainsModelStatus: 'NOT_READY' });
  }

  async _get(id, requester) {
    const job = await this.ctx.storage.get(JOB_PREFIX + id);
    if (!job) return response(404, { status: 'error', message: 'Job not found' });
    if (job.requested_by !== requester) return response(403, { status: 'error', message: 'Job access denied' });
    return response(200, { status: 'success', job, modelType: 'TEST MODEL', sainsModelStatus: 'NOT_READY' });
  }

  async _latest(requester) {
    const all = await this.ctx.storage.list({ prefix: JOB_PREFIX });
    const job = [...all.values()].filter(row => row.requested_by === requester && row.status === 'COMPLETED')
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0];
    return job ? response(200, { status: 'success', job, modelType: 'TEST MODEL', sainsModelStatus: 'NOT_READY' })
      : response(404, { status: 'error', message: 'No completed reference job' });
  }

  async executeJob({ jobId }) {
    let job = await this.ctx.storage.get(JOB_PREFIX + jobId);
    if (!job || job.status !== 'QUEUED') return;
    const started = Date.now();
    job = { ...job, status: 'RUNNING', attempts: job.attempts + 1, started_at: iso(),
      queue_delay_ms: started - Date.parse(job.created_at) };
    await this.ctx.storage.put(JOB_PREFIX + jobId, job);
    try {
      const upstream = await this._container('/v1/solve', { method: 'POST',
        body: JSON.stringify({ modelId: MODEL, scenario: job.scenario, settings: job.settings }) });
      const raw = await upstream.text();
      if (raw.length > MAX_RESULT) throw new Error('OUTPUT_LIMIT');
      const payload = JSON.parse(raw);
      if (!upstream.ok) throw new Error(`UPSTREAM_${upstream.status}_${String(payload.errorCode || 'ERROR').slice(0, 32)}`);
      if (!upstream.ok || payload.status !== 'success' || payload.result?.modelId !== MODEL ||
          !Number.isFinite(payload.result?.summary?.minimumPressureM) || !payload.geojson?.features)
        throw new Error('UPSTREAM_INVALID_RESULT');
      const persistStarted = Date.now();
      job = { ...job, status: 'COMPLETED', completed_at: iso(), result: payload.result,
        summary: payload.result.summary, geojson: payload.geojson, warnings: payload.result.warnings || [],
        solver_duration_ms: payload.solverDurationMs, persistence_duration_ms: null };
      await this.ctx.storage.put(JOB_PREFIX + jobId, job);
      job.persistence_duration_ms = Date.now() - persistStarted;
      await this.ctx.storage.put(JOB_PREFIX + jobId, job);
      console.log(JSON.stringify({ event: 'container_job_completed', jobId, model: MODEL }));
    } catch (error) {
      const retry = job.attempts < 2;
      job = { ...job, status: retry ? 'QUEUED' : 'FAILED', completed_at: retry ? null : iso(),
        error_code: /^UPSTREAM_[0-9]{3}_[A-Z_]{1,32}$/.test(error.message) ? error.message :
          error.name === 'TimeoutError' ? 'TIMEOUT' : 'SOLVER_FAILED',
        error_message: retry ? 'Retry scheduled' : 'Reference simulation failed', result: null, summary: null, geojson: null };
      await this.ctx.storage.put(JOB_PREFIX + jobId, job);
      if (retry) await this.schedule(2, 'executeJob', { jobId });
      console.log(JSON.stringify({ event: 'container_job_error', jobId, type: error.name,
        code: job.error_code, retry }));
    }
  }

  async recoverJob({ jobId }) {
    const job = await this.ctx.storage.get(JOB_PREFIX + jobId);
    if (!job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return;
    if (job.attempts >= 2) {
      await this.ctx.storage.put(JOB_PREFIX + jobId, { ...job, status: 'FAILED', completed_at: iso(),
        error_code: 'INTERRUPTED', error_message: 'Reference job interrupted; retry limit reached' });
      return;
    }
    await this.ctx.storage.put(JOB_PREFIX + jobId, { ...job, status: 'QUEUED', error_code: 'INTERRUPTED' });
    await this.schedule(1, 'executeJob', { jobId });
  }
}

export default {
  async fetch(request, env) {
    if (!sameSecret(request.headers.get('X-Sains-Simulation-Token'), env.HYDRAULIC_SERVICE_TOKEN))
      return response(401, { status: 'error', message: 'Service authentication required' });
    return getContainer(env.HYDRAULIC_TEST_CONTAINER, 'phase2bs-reference-v1').fetch(request);
  }
};
