-- Additive GIS candidate intake. Nothing here can activate pipe_network_active.
-- Uploaded geometry is a spatial candidate, NOT approved DMA membership or an
-- engineering/hydraulic model. Raw KML remains outside D1.
CREATE TABLE IF NOT EXISTS pipe_candidate_imports (
  batch_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  declared_source_sha256 TEXT NOT NULL,
  polygon_sha256 TEXT NOT NULL,
  source_line_count INTEGER NOT NULL CHECK(source_line_count>=0),
  expected_part_count INTEGER NOT NULL CHECK(expected_part_count>0 AND expected_part_count<=20000),
  outside_line_count INTEGER NOT NULL CHECK(outside_line_count>=0),
  multi_dma_line_count INTEGER NOT NULL CHECK(multi_dma_line_count>=0),
  invalid_geometry_count INTEGER NOT NULL CHECK(invalid_geometry_count>=0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','REVIEW_REQUIRED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipe_candidate_imports_source
  ON pipe_candidate_imports(declared_source_sha256,polygon_sha256,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipe_candidate_imports_same_input
  ON pipe_candidate_imports(declared_source_sha256,polygon_sha256,created_by);

CREATE TABLE IF NOT EXISTS pipe_candidate_parts (
  batch_id TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK(row_number>=0),
  zone_name TEXT NOT NULL,
  kml_id TEXT,
  diameter_mm REAL CHECK(diameter_mm IS NULL OR diameter_mm>0),
  geometry_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  geometry_length_m REAL NOT NULL CHECK(geometry_length_m>0),
  PRIMARY KEY(batch_id,row_number),
  FOREIGN KEY(batch_id) REFERENCES pipe_candidate_imports(batch_id)
);
CREATE INDEX IF NOT EXISTS idx_pipe_candidate_parts_zone
  ON pipe_candidate_parts(batch_id,zone_name,kml_id);
CREATE TRIGGER IF NOT EXISTS pipe_candidate_parts_no_update
  BEFORE UPDATE ON pipe_candidate_parts BEGIN SELECT RAISE(ABORT,'Candidate parts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS pipe_candidate_parts_no_delete
  BEFORE DELETE ON pipe_candidate_parts BEGIN SELECT RAISE(ABORT,'Candidate parts are append-only'); END;
