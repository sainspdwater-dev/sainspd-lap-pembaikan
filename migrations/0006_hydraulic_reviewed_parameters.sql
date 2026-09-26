-- Phase 2C/2D CANDIDATE ONLY. Apply after 0005 and an approved release plan.
-- Append-only review records; never overwrite GIS or operational observations.
CREATE TABLE IF NOT EXISTS hydraulic_parameter_reviews (
  entry_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('PIPE','NODE','SOURCE','VALVE','PUMP','TANK','PATTERN','MODEL')),
  entity_id TEXT NOT NULL,
  parameter_name TEXT NOT NULL,
  value_real REAL,
  value_text TEXT,
  unit TEXT,
  classification TEXT NOT NULL CHECK(classification IN ('VERIFIED','MANUAL','ASSUMED','MISSING')),
  source_ref TEXT,
  source_sha256 TEXT,
  effective_at TEXT,
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  review_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(review_status IN ('DRAFT','APPROVED','REJECTED')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  supersedes_entry_id TEXT,
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version),
  FOREIGN KEY(supersedes_entry_id) REFERENCES hydraulic_parameter_reviews(entry_id),
  CHECK(classification='MISSING' OR value_real IS NOT NULL OR length(trim(COALESCE(value_text,'')))>0),
  CHECK(classification='MISSING' OR length(trim(COALESCE(source_ref,'')))>0),
  CHECK(review_status!='APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_hydraulic_parameter_reviews_entity
  ON hydraulic_parameter_reviews(model_id,version,entity_type,entity_id,parameter_name,entered_at);
CREATE TRIGGER IF NOT EXISTS hydraulic_parameter_reviews_no_update
  BEFORE UPDATE ON hydraulic_parameter_reviews BEGIN SELECT RAISE(ABORT,'Review records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS hydraulic_parameter_reviews_no_delete
  BEFORE DELETE ON hydraulic_parameter_reviews BEGIN SELECT RAISE(ABORT,'Review records are append-only'); END;

-- A sensor is never matched to a model node/link by proximity alone.
CREATE TABLE IF NOT EXISTS hydraulic_sensor_mappings (
  mapping_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  district_metered_area TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  observed_parameter TEXT NOT NULL CHECK(observed_parameter IN ('FLOW','INLET_PRESSURE','CP_PRESSURE')),
  observed_unit TEXT NOT NULL,
  model_entity_type TEXT NOT NULL CHECK(model_entity_type IN ('NODE','LINK')),
  model_entity_id TEXT NOT NULL,
  simulated_unit TEXT NOT NULL,
  conversion_basis TEXT,
  review_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(review_status IN ('DRAFT','APPROVED','REJECTED')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  source_ref TEXT NOT NULL,
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version),
  CHECK(review_status!='APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK(observed_unit=simulated_unit OR conversion_basis IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hydraulic_sensor_mappings_unique
  ON hydraulic_sensor_mappings(model_id,version,district_metered_area,sensor_id,observed_parameter);
