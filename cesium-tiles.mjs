// Cesium OSM Buildings is a separate 3D Tiles layer. GIS pipes remain 2D asset context,
// not surveyed pipe elevations, depths, or an approved hydraulic model.
export function buildingStyle(mode) {
  const plain = {
    blue: '#2563eb', green: '#16a34a', orange: '#ea580c',
  };
  if (mode === 'original') return undefined;
  if (Object.hasOwn(plain, mode)) return {color: `color('${plain[mode]}', 0.85)`};
  if (mode === 'material') return {color: {conditions: [
    ["${feature['building:material']} === 'brick'", "color('#dc6b48')"],
    ["${feature['building:material']} === 'concrete'", "color('#94a3b8')"],
    ["${feature['building:material']} === 'metal'", "color('#60a5fa')"],
    ['true', "color('#e2e8f0')"],
  ]}};
  if (mode === 'residential') return {color: {conditions: [
    ["${feature['building']} === 'house' || ${feature['building']} === 'residential' || ${feature['building']} === 'apartments'", "color('#f59e0b')"],
    ['true', "color('#94a3b8', 0.22)"],
  ]}};
  if (mode === 'office') return {color: {conditions: [
    ["${feature['building']} === 'office' || ${feature['building']} === 'commercial' || ${feature['building']} === 'retail'", "color('#a855f7')"],
    ['true', "color('#94a3b8', 0.22)"],
  ]}};
  throw new Error('Gaya 3D Tiles tidak dikenali.');
}

export function bindBuildingTiles(C, viewer, controls) {
  const style = controls.querySelector('[data-tiles-style]');
  const token = controls.querySelector('[data-tiles-token]');
  const load = controls.querySelector('[data-tiles-load]');
  const message = controls.querySelector('[data-tiles-status]');
  const listeners = new AbortController();
  let tileset = null;
  let disposed = false;
  const report = value => { if (!disposed) message.textContent = value; };
  const apply = () => {
    if (!tileset) return;
    const definition = buildingStyle(style.value);
    tileset.style = definition === undefined ? undefined : new C.Cesium3DTileStyle(definition);
    report('Bangunan OSM 3D Tiles aktif. Warna/highlight hanya mengikut metadata OSM; bukan bukti lokasi atau aras paip SAINS.');
  };
  style.addEventListener('change', apply, {signal: listeners.signal});
  load.addEventListener('click', async () => {
    if (tileset) { apply(); return; }
    const accessToken = token.value.trim();
    if (!accessToken) {
      report('Masukkan token Cesium ion dengan assets:read untuk OSM Buildings (asset 96188). Jangan masukkan token pentadbir.');
      token.focus();
      return;
    }
    load.disabled = true;
    report('Memuat bangunan OSM 3D Tiles...');
    try {
      // Pass the explicitly supplied token to this asset only; never use Cesium's demo token.
      const resource = await C.IonResource.fromAssetId(96188, {accessToken});
      const next = await C.Cesium3DTileset.fromUrl(resource);
      if (disposed || viewer.isDestroyed()) { next.destroy(); return; }
      tileset = viewer.scene.primitives.add(next);
      token.value = '';
      apply();
      tileset.tileFailed?.addEventListener(() => report('Sebahagian 3D Tiles gagal dimuat. Semak token, sambungan dan had Cesium ion.'));
    } catch (_) {
      // Never surface an exception URL: ion request errors may contain the token.
      report('Bangunan 3D Tiles gagal dimuat. Semak token assets:read, akses asset 96188 dan URL yang dibenarkan di Cesium ion.');
    } finally {
      if (!disposed) load.disabled = Boolean(tileset);
    }
  }, {signal: listeners.signal});
  return {destroy() { disposed = true; listeners.abort(); token.value = ''; tileset = null; }};
}
