-- Private pipe geometry snapshots. Do not publish raw KML or generated GeoJSON
-- into the public GitHub Pages repository.
CREATE TABLE IF NOT EXISTS pipe_network_imports (
    import_id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    inputs_sha256 TEXT NOT NULL,
    line_count INTEGER NOT NULL CHECK (line_count >= 0),
    zone_line_count INTEGER NOT NULL CHECK (zone_line_count >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipe_network_segments (
    import_id TEXT NOT NULL,
    segment_key TEXT NOT NULL,
    asset_num TEXT,
    material TEXT,
    size_mm REAL,
    nrw_zone TEXT,
    geometry_json TEXT NOT NULL,
    geometry_sha256 TEXT NOT NULL,
    length_m REAL NOT NULL CHECK (length_m >= 0),
    min_lng REAL NOT NULL,
    min_lat REAL NOT NULL,
    max_lng REAL NOT NULL,
    max_lat REAL NOT NULL,
    PRIMARY KEY (import_id, segment_key),
    FOREIGN KEY (import_id) REFERENCES pipe_network_imports(import_id)
);
CREATE INDEX IF NOT EXISTS idx_pipe_segments_asset
    ON pipe_network_segments (import_id, asset_num);
CREATE INDEX IF NOT EXISTS idx_pipe_segments_bbox
    ON pipe_network_segments (import_id, min_lng, max_lng, min_lat, max_lat);

-- One source segment can have several clipped parts in a DMA. Membership comes
-- from the matching CSV asset ID; spatial intersection alone is insufficient.
CREATE TABLE IF NOT EXISTS pipe_network_zone_lines (
    import_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    segment_key TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    asset_num TEXT NOT NULL,
    geometry_json TEXT NOT NULL,
    length_m REAL NOT NULL CHECK (length_m >= 0),
    min_lng REAL NOT NULL,
    min_lat REAL NOT NULL,
    max_lng REAL NOT NULL,
    max_lat REAL NOT NULL,
    PRIMARY KEY (import_id, zone_name, segment_key, part_index),
    FOREIGN KEY (import_id, segment_key)
        REFERENCES pipe_network_segments(import_id, segment_key)
);
CREATE INDEX IF NOT EXISTS idx_pipe_zone_lines_name
    ON pipe_network_zone_lines (import_id, zone_name, asset_num);

CREATE TABLE IF NOT EXISTS pipe_network_active (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    import_id TEXT NOT NULL,
    activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (import_id) REFERENCES pipe_network_imports(import_id)
);
