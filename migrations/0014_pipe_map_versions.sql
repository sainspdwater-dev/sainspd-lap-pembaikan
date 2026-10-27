-- Versioned display-only KML line layer. The authoritative pipe_network_* tables,
-- DMA polygons, asset register and hydraulic approvals are deliberately untouched.
CREATE TABLE IF NOT EXISTS pipe_map_imports (
  import_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  polygon_sha256 TEXT NOT NULL,
  source_line_count INTEGER NOT NULL,
  expected_part_count INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  previous_import_id TEXT
);
CREATE TABLE IF NOT EXISTS pipe_map_lines (
  import_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  zone_name TEXT NOT NULL,
  kml_id TEXT,
  diameter_mm REAL,
  geometry_json TEXT NOT NULL,
  geometry_length_m REAL NOT NULL,
  min_lng REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lng REAL NOT NULL,
  max_lat REAL NOT NULL,
  PRIMARY KEY(import_id,row_number),
  FOREIGN KEY(import_id) REFERENCES pipe_map_imports(import_id)
);
CREATE INDEX IF NOT EXISTS idx_pipe_map_lines_zone ON pipe_map_lines(import_id,zone_name,row_number);
CREATE INDEX IF NOT EXISTS idx_pipe_map_lines_bbox ON pipe_map_lines(import_id,min_lng,max_lng,min_lat,max_lat);
CREATE TABLE IF NOT EXISTS pipe_map_active (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  import_id TEXT NOT NULL,
  activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(import_id) REFERENCES pipe_map_imports(import_id)
);
