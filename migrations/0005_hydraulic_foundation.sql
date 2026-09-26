-- Phase 2B candidate migration. NOT APPLIED TO PRODUCTION until release gate.
-- Additive only; GIS asset master and Phase 2A telemetry remain untouched.
CREATE TABLE IF NOT EXISTS hydraulic_models (
  model_id TEXT PRIMARY KEY,
  zone_name TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  active_version INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hydraulic_model_versions (
  model_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  source_import_id TEXT,
  source_dataset_sha256 TEXT,
  topology_version TEXT NOT NULL,
  parameter_version TEXT NOT NULL,
  snap_tolerance_m REAL NOT NULL CHECK(snap_tolerance_m>=0 AND snap_tolerance_m<=20),
  validation_status TEXT NOT NULL CHECK(validation_status IN ('NOT_READY','PARTIAL','EXPERIMENTAL','UNCALIBRATED','CALIBRATED','VALIDATED')),
  calibration_status TEXT NOT NULL CHECK(calibration_status IN ('NOT_STARTED','IN_PROGRESS','REVIEWED')),
  assumptions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(assumptions_json)),
  limitations_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(limitations_json)),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY(model_id,version),
  FOREIGN KEY(model_id) REFERENCES hydraulic_models(model_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hydraulic_one_active_version ON hydraulic_model_versions(model_id) WHERE active=1;
CREATE TABLE IF NOT EXISTS hydraulic_nodes (
  model_id TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK(node_type IN ('JUNCTION','RESERVOIR','TANK')),
  longitude REAL, latitude REAL, elevation_m REAL,
  node_origin TEXT NOT NULL CHECK(node_origin IN ('VERIFIED','GENERATED','MANUAL','UNRESOLVED')),
  generation_method TEXT, source_ref TEXT, linked_pipe_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(linked_pipe_ids_json)),
  provenance TEXT, effective_at TEXT, verified_by TEXT, manual_override INTEGER NOT NULL DEFAULT 0 CHECK(manual_override IN (0,1)),
  PRIMARY KEY(model_id,version,node_id),
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version)
);
CREATE TABLE IF NOT EXISTS hydraulic_links (
  model_id TEXT NOT NULL, version INTEGER NOT NULL, link_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK(link_type IN ('PIPE','PUMP','VALVE')),
  start_node_id TEXT NOT NULL, end_node_id TEXT NOT NULL,
  asset_num TEXT, source_segment_key TEXT,
  length_m REAL, length_source TEXT CHECK(length_source IN ('VERIFIED_ASSET','ENGINEERING','GEOMETRY_DERIVED','MISSING')),
  diameter_mm REAL, diameter_source TEXT,
  roughness REAL, roughness_equation TEXT, roughness_source TEXT, roughness_status TEXT CHECK(roughness_status IN ('VERIFIED','MANUAL','ASSUMED_FROM_MATERIAL','MISSING')),
  roughness_effective_at TEXT, roughness_authority TEXT, roughness_notes TEXT,
  pump_curve_json TEXT CHECK(pump_curve_json IS NULL OR json_valid(pump_curve_json)),
  valve_type TEXT, valve_setting REAL, operational_status TEXT,
  provenance TEXT, effective_at TEXT,
  PRIMARY KEY(model_id,version,link_id),
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version)
);
CREATE INDEX IF NOT EXISTS idx_hydraulic_links_asset ON hydraulic_links(asset_num);
CREATE TABLE IF NOT EXISTS hydraulic_demands (
  model_id TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL, demand_category TEXT NOT NULL,
  base_m3s REAL NOT NULL CHECK(base_m3s>=0), pattern_id TEXT, allocation_method TEXT NOT NULL,
  source TEXT NOT NULL, unit_original TEXT NOT NULL, effective_at TEXT NOT NULL, verified_by TEXT,
  PRIMARY KEY(model_id,version,node_id,demand_category),
  FOREIGN KEY(model_id,version,node_id) REFERENCES hydraulic_nodes(model_id,version,node_id)
);
CREATE TABLE IF NOT EXISTS hydraulic_patterns (
  model_id TEXT NOT NULL, version INTEGER NOT NULL, pattern_id TEXT NOT NULL, multipliers_json TEXT NOT NULL CHECK(json_valid(multipliers_json)),
  source TEXT NOT NULL, effective_at TEXT NOT NULL, approved_by TEXT,
  PRIMARY KEY(model_id,version,pattern_id)
);
CREATE TABLE IF NOT EXISTS hydraulic_boundaries (
  model_id TEXT NOT NULL, version INTEGER NOT NULL, node_id TEXT NOT NULL,
  boundary_type TEXT NOT NULL CHECK(boundary_type IN ('RESERVOIR','TANK')),
  head_m REAL, initial_level_m REAL, min_level_m REAL, max_level_m REAL, diameter_m REAL,
  source TEXT NOT NULL, effective_at TEXT NOT NULL, verified_by TEXT,
  PRIMARY KEY(model_id,version,node_id)
);
CREATE TABLE IF NOT EXISTS hydraulic_model_issues (
  model_id TEXT NOT NULL, version INTEGER NOT NULL, issue_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('CRITICAL','MISSING','WARNING')),
  issue_code TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT,
  resolved_at TEXT, resolution_method TEXT, resolved_by TEXT,
  PRIMARY KEY(model_id,version,issue_id)
);
-- Pre-model GIS findings are review records, never automatic geometry edits.
CREATE TABLE IF NOT EXISTS hydraulic_topology_issues (
  import_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('CRITICAL','MISSING','WARNING')),
  segment_key TEXT,
  related_segment_key TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  issue_status TEXT NOT NULL DEFAULT 'UNRESOLVED'
    CHECK(issue_status IN ('UNRESOLVED','AUTO_SUGGESTED','MANUAL_REVIEW_REQUIRED','VERIFIED','IGNORED_WITH_REASON')),
  proposed_action TEXT,
  review_reason TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(import_id,issue_id),
  FOREIGN KEY(import_id) REFERENCES pipe_network_imports(import_id),
  CHECK(issue_status!='IGNORED_WITH_REASON' OR length(trim(COALESCE(review_reason,'')))>0),
  CHECK(issue_status!='VERIFIED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_hydraulic_topology_issue_status
  ON hydraulic_topology_issues(import_id,issue_status,issue_type);
CREATE TABLE IF NOT EXISTS hydraulic_scenarios (
  scenario_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, version INTEGER NOT NULL,
  scenario_type TEXT NOT NULL, parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  parameter_hash TEXT NOT NULL, is_test_data INTEGER NOT NULL DEFAULT 0 CHECK(is_test_data IN (0,1)),
  investigation_id TEXT, candidate_pipe_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT NOT NULL,
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version)
);
CREATE TABLE IF NOT EXISTS hydraulic_simulation_jobs (
  simulation_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, version INTEGER NOT NULL, scenario_id TEXT,
  requested_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  engine_version TEXT NOT NULL, input_sha256 TEXT NOT NULL, error_code TEXT, solver_message TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
  summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)),
  detail_expires_at TEXT, is_test_data INTEGER NOT NULL DEFAULT 0 CHECK(is_test_data IN (0,1)),
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version)
);
CREATE INDEX IF NOT EXISTS idx_hydraulic_jobs_model_status ON hydraulic_simulation_jobs(model_id,version,status,created_at);
CREATE TABLE IF NOT EXISTS hydraulic_calibration_runs (
  calibration_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, version INTEGER NOT NULL,
  observation_start TEXT NOT NULL, observation_end TEXT NOT NULL, observation_count INTEGER NOT NULL CHECK(observation_count>=0),
  pressure_mae REAL, pressure_rmse REAL, pressure_bias REAL, flow_mae REAL, flow_rmse REAL, flow_bias REAL,
  sensor_ids_json TEXT NOT NULL CHECK(json_valid(sensor_ids_json)),
  review_status TEXT NOT NULL CHECK(review_status IN ('DRAFT','REVIEWED','REJECTED')),
  reviewed_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(model_id,version) REFERENCES hydraulic_model_versions(model_id,version)
);
