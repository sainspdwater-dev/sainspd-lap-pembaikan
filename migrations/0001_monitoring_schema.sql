-- Add the columns already expected by logAiHistory().
-- Run once against the current production schema.
ALTER TABLE ai_chat_history ADD COLUMN district_metered_area TEXT;
ALTER TABLE ai_chat_history ADD COLUMN agent_type TEXT;
ALTER TABLE ai_chat_history ADD COLUMN params_json TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_chat_history_session_created
    ON ai_chat_history (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dma_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    district_metered_area TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    flow_m3h REAL,
    pressure_inlet_bar REAL,
    pressure_cp_bar REAL,
    legitimate_night_use_m3h REAL,
    source TEXT NOT NULL DEFAULT 'dashboard',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dma_telemetry_dma_time
    ON dma_telemetry (district_metered_area, recorded_at DESC);

CREATE TABLE IF NOT EXISTS dma_sensors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    district_metered_area TEXT NOT NULL,
    sensor_type TEXT NOT NULL,
    sensor_name TEXT NOT NULL,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    updated_at TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (district_metered_area, sensor_type, sensor_name)
);

CREATE INDEX IF NOT EXISTS idx_dma_sensors_dma
    ON dma_sensors (district_metered_area);

CREATE TABLE IF NOT EXISTS ald_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    district_metered_area TEXT NOT NULL,
    inspected_at TEXT NOT NULL,
    location TEXT,
    result_status TEXT NOT NULL CHECK (result_status IN ('CONFIRMED_LEAK', 'NO_LEAK', 'SUSPECTED')),
    estimated_leak_m3h REAL CHECK (estimated_leak_m3h IS NULL OR estimated_leak_m3h >= 0),
    notes TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ald_results_dma_time
    ON ald_results (district_metered_area, inspected_at DESC);
