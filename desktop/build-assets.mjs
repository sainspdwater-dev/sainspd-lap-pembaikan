import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = path.dirname(directory);
const output = path.join(directory, 'app');
const assets = [
  ['https://cdn.tailwindcss.com', 'vendor/tailwind.js'],
  ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'vendor/leaflet.css'],
  ['https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css', 'vendor/MarkerCluster.Default.css'],
  ['https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css', 'vendor/jquery.dataTables.min.css'],
  ['https://cdn.datatables.net/buttons/2.4.2/css/buttons.dataTables.min.css', 'vendor/buttons.dataTables.min.css'],
  ['https://cdn.datatables.net/fixedcolumns/4.3.0/css/fixedColumns.dataTables.min.css', 'vendor/fixedColumns.dataTables.min.css'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css', 'vendor/fontawesome.css'],
  ['https://code.jquery.com/jquery-3.7.1.min.js', 'vendor/jquery.min.js'],
  ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'vendor/leaflet.js'],
  ['https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js', 'vendor/leaflet.markercluster.js'],
  ['https://unpkg.com/leaflet.heat/dist/leaflet-heat.js', 'vendor/leaflet-heat.js'],
  ['https://unpkg.com/@turf/turf@6/turf.min.js', 'vendor/turf.min.js'],
  ['https://unpkg.com/leaflet-omnivore@0.3.4/leaflet-omnivore.min.js', 'vendor/leaflet-omnivore.min.js'],
  ['https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js', 'vendor/jquery.dataTables.min.js'],
  ['https://cdn.datatables.net/buttons/2.4.2/js/dataTables.buttons.min.js', 'vendor/dataTables.buttons.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'vendor/jszip.min.js'],
  ['https://cdn.datatables.net/buttons/2.4.2/js/buttons.html5.min.js', 'vendor/buttons.html5.min.js'],
  ['https://cdn.datatables.net/fixedcolumns/4.3.0/js/dataTables.fixedColumns.min.js', 'vendor/dataTables.fixedColumns.min.js'],
  ['https://cdn.jsdelivr.net/npm/apexcharts', 'vendor/apexcharts.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'vendor/xlsx.full.min.js'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', 'vendor/images/marker-icon.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png', 'vendor/images/marker-icon-2x.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', 'vendor/images/marker-shadow.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/layers.png', 'vendor/images/layers.png'],
  ['https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png', 'vendor/images/layers-2x.png'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2', 'webfonts/fa-solid-900.woff2'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2', 'webfonts/fa-regular-400.woff2'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2', 'webfonts/fa-brands-400.woff2']
];

await mkdir(output, { recursive: true });
for (const filename of ['index.html', 'dashboard.html', 'engineering-template.csv', 'phase2a-ui.js', 'phase2b-ui.js', 'engineering-intake.mjs', 'ai-prompt-hydraulic-guide.mjs', 'pipe-clip-ui.mjs', 'pipe-clip-preview.mjs', 'kml-namespace.mjs', 'ai-map-capture.mjs', 'kolam-readings.mjs']) {
  await cp(path.join(source, filename), path.join(output, filename));
}
await cp(path.join(source, 'map polygon'), path.join(output, 'map polygon'), { recursive: true });

for (const [url, filename] of assets) {
  const target = path.join(output, filename);
  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Asset download failed ${response.status}: ${url}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  console.log(`Bundled ${filename}`);
}

for (const filename of ['index.html', 'dashboard.html']) {
  let html = await readFile(path.join(output, filename), 'utf8');
  for (const [url, asset] of assets) html = html.replaceAll(url, asset);
  html = html.replace(/\s*<link rel="preconnect" href="https:\/\/[^\"]+"[^>]*>/g, '');
  // These online font requests are optional. Retain their CSS fallbacks without a runtime network dependency.
  html = html.replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.(?:googleapis|gstatic)\.com"[^>]*>/g, '');
  html = html.replace(/\s*<link href="https:\/\/fonts\.googleapis\.com\/[^\"]+" rel="stylesheet">/g, '');
  html = html.replace('</head>', '    <script src="desktop-store.js"></script>\n</head>');
  if (filename === 'dashboard.html') html = html.replace('</body>', '    <script src="desktop-offline.js" defer></script>\n</body>');
  html = html.replace('</body>', '    <script src="desktop-update.js" defer></script>\n</body>');
  await writeFile(path.join(output, filename), html);
}
await cp(path.join(directory, 'offline-dashboard.js'), path.join(output, 'desktop-offline.js'));
await cp(path.join(directory, 'local-db.js'), path.join(output, 'desktop-store.js'));
await cp(path.join(directory, 'update-ui.js'), path.join(output, 'desktop-update.js'));
console.log('Desktop bundle prepared.');
