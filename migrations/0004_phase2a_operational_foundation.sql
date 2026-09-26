-- Phase 2A. Additive only; review and back up production before applying.
-- Existing wide telemetry columns remain for the current AI and old records.
-- New observations use one parameter per row, with its matching wide column
-- populated for backward compatibility. Rows lacking a real measurement time
-- are held as import issues, not inserted with an invented recorded_at value.
ALTER TABLE dma_telemetry ADD COLUMN observation_uid TEXT;
ALTER TABLE dma_telemetry ADD COLUMN sensor_id TEXT;
ALTER TABLE dma_telemetry ADD COLUMN parameter TEXT;
ALTER TABLE dma_telemetry ADD COLUMN value REAL;
ALTER TABLE dma_telemetry ADD COLUMN unit TEXT;
ALTER TABLE dma_telemetry ADD COLUMN timestamp_provenance TEXT;
ALTER TABLE dma_telemetry ADD COLUMN quality_status TEXT;
ALTER TABLE dma_telemetry ADD COLUMN import_batch_id TEXT;
ALTER TABLE dma_telemetry ADD COLUMN remark TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dma_telemetry_observation_uid
    ON dma_telemetry(observation_uid) WHERE observation_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dma_telemetry_parameter_time
    ON dma_telemetry(district_metered_area, parameter, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_dma_telemetry_import_batch
    ON dma_telemetry(import_batch_id);

CREATE TABLE IF NOT EXISTS operational_import_batches (
    batch_id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    mapping_json TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('UPLOADED','VALIDATING','IMPORTING','PARTIAL','COMPLETED','FAILED')),
    rows_detected INTEGER NOT NULL DEFAULT 0,
    rows_accepted INTEGER NOT NULL DEFAULT 0,
    rows_rejected INTEGER NOT NULL DEFAULT 0,
    duplicates_skipped INTEGER NOT NULL DEFAULT 0,
    conflicts_skipped INTEGER NOT NULL DEFAULT 0,
    missing_timestamp INTEGER NOT NULL DEFAULT 0,
    invalid_timestamp INTEGER NOT NULL DEFAULT 0,
    missing_dma INTEGER NOT NULL DEFAULT 0,
    missing_cp INTEGER NOT NULL DEFAULT 0,
    invalid_value INTEGER NOT NULL DEFAULT 0,
    unknown_parameter INTEGER NOT NULL DEFAULT 0,
    validation_summary_json TEXT
);

CREATE TABLE IF NOT EXISTS operational_import_chunks (
    batch_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    chunk_sha256 TEXT NOT NULL,
    report_json TEXT NOT NULL,
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(batch_id,part_index),
    FOREIGN KEY(batch_id) REFERENCES operational_import_batches(batch_id)
);

CREATE TABLE IF NOT EXISTS operational_import_issues (
    batch_id TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    issue_code TEXT NOT NULL,
    dma TEXT,
    parameter TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(batch_id,row_number,issue_code,parameter),
    FOREIGN KEY(batch_id) REFERENCES operational_import_batches(batch_id)
);
CREATE INDEX IF NOT EXISTS idx_operational_import_issues_batch
    ON operational_import_issues(batch_id);

-- Assessment and field confirmation are separate, linked records.
CREATE TABLE IF NOT EXISTS ald_investigations (
    investigation_id TEXT PRIMARY KEY,
    district_metered_area TEXT NOT NULL,
    assessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assessment_status TEXT NOT NULL,
    candidate_pipe_id TEXT,
    assessment_note TEXT,
    created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ald_investigations_dma_time
    ON ald_investigations(district_metered_area, assessed_at DESC);

ALTER TABLE ald_results ADD COLUMN investigation_id TEXT;
ALTER TABLE ald_results ADD COLUMN pipe_id TEXT;
ALTER TABLE ald_results ADD COLUMN result_category TEXT;
ALTER TABLE ald_results ADD COLUMN repair_reference TEXT;
ALTER TABLE ald_results ADD COLUMN confirmed_by TEXT;
ALTER TABLE ald_results ADD COLUMN field_event_uid TEXT;
CREATE INDEX IF NOT EXISTS idx_ald_results_investigation
    ON ald_results(investigation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ald_results_field_event_uid
    ON ald_results(field_event_uid) WHERE field_event_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS storage_cleanup_audit (
    cleanup_id TEXT PRIMARY KEY,
    performed_by TEXT NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    category TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','FAILED')),
    before_count INTEGER NOT NULL,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    after_count INTEGER,
    protected_assets_before INTEGER NOT NULL,
    protected_assets_after INTEGER,
    protected_segments_before INTEGER NOT NULL,
    protected_segments_after INTEGER,
    protected_zone_lines_before INTEGER NOT NULL,
    protected_zone_lines_after INTEGER,
    protected_ald_before INTEGER NOT NULL,
    protected_ald_after INTEGER,
    error_code TEXT
);
