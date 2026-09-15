-- Non-destructive canonical view: removes exact duplicate geometries without
-- deleting the source rows. The Worker can aggregate this view immediately.
CREATE VIEW IF NOT EXISTS water_assets_unique AS
SELECT DISTINCT
    asset_num,
    ref_id,
    zone,
    water_source,
    material,
    size,
    length,
    x_start,
    y_start,
    x_end,
    y_end,
    folder_name,
    source_file
FROM water_assets;

CREATE VIEW IF NOT EXISTS water_assets_quality AS
SELECT
    COUNT(*) AS raw_rows,
    (SELECT COUNT(*) FROM water_assets_unique) AS unique_rows,
    SUM(CASE WHEN NULLIF(TRIM(material), '') IS NULL THEN 1 ELSE 0 END) AS missing_material_rows,
    SUM(CASE WHEN size IS NULL OR size <= 0 THEN 1 ELSE 0 END) AS missing_size_rows,
    SUM(CASE WHEN length IS NULL OR length <= 0 THEN 1 ELSE 0 END) AS missing_length_rows,
    SUM(CASE WHEN COALESCE(x_start, 0) = 0 AND COALESCE(y_start, 0) = 0
                  AND COALESCE(x_end, 0) = 0 AND COALESCE(y_end, 0) = 0
             THEN 1 ELSE 0 END) AS zero_coordinate_rows
FROM water_assets;
