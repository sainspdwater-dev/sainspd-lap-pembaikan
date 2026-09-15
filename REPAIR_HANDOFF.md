# Laporan pembaikan sainspd-lap-pembaikan

Tarikh: 15 September 2026

## Sudah diterapkan pada D1 produksi

- Menambah `district_metered_area`, `agent_type`, dan `params_json` pada
  `ai_chat_history` supaya log Worker tidak lagi gagal secara senyap.
- Mencipta `dma_telemetry`, `dma_sensors`, dan `ald_results` bersama indeks dan
  kekangan asas.
- Mencipta view `water_assets_unique` tanpa memadam rekod sumber.
- Mencipta view `water_assets_quality` untuk audit data.

Pengesahan view produksi:

- Baris mentah: 9,428
- Geometri unik: 2,964
- Material kosong: 2,090
- Saiz kosong/tidak positif: 314
- Panjang kosong/tidak positif: 1,599
- Koordinat semuanya sifar: 1,599

## Draf Worker dalam Cloudflare Quick Edit

Draf belum dideploy. Ia mempunyai empat perubahan:

1. Nilai `null`, `undefined`, rentetan kosong dan ruang kosong kekal sebagai
   nilai tiada; ia tidak lagi ditukar kepada sifar.
2. `avgMnf` kosong kini jatuh balik kepada `avgFlow` dengan betul.
3. Agregasi profil aset menggunakan `water_assets_unique`.
4. Handler `scheduled()` tanpa mutasi data ditambah untuk cron 20 minit.

Cloudflare Quick Edit melaporkan `0 error / 0 warning`, dan preview scheduled
event berjaya dipanggil. Butang Deploy sengaja tidak ditekan.

## Perubahan frontend dalam pakej ini

- GeoJSON diparse sebagai JSON/GeoJSON, bukan lagi dihantar ke parser KML.
- KML/KMZ/GeoJSON kini menunggu proses parse selesai sebelum mesej berjaya.
- CRS diperiksa; geometri di luar julat WGS84 ditolak dengan arahan EPSG:4326.
- Butang fungsi yang hilang diganti dengan `Semak Spatial` yang mengira bilangan
  fitur, panjang garisan dan luas poligon menggunakan Turf.
- Ringkasan spatial dihantar sebagai parameter kepada Worker.
- Koordinat separa/kosong dan nombor tidak sah tidak lagi menjadi sifar palsu.
- Reset turut membuang layer dan ringkasan spatial yang dimuat naik.
- Teks UI menerangkan bahawa analisis semasa berasaskan data dan peraturan.

## Pengesahan

- Semua skrip JavaScript sebaris dalam `dashboard.html` berjaya diparse.
- Ujian regresi nilai kosong dan fallback MNF lulus.
- Kedua-dua fail migrasi berjaya diaplikasi pada SQLite sementara.
- Skema dan view baharu disahkan terus di D1 produksi.
- Tiada rekod `water_assets` dipadam atau diubah.

## Langkah penerbitan yang masih belum dibuat

1. Semak draf Worker dalam Cloudflare Quick Edit dan tekan Deploy.
2. Commit/push `dashboard.html`, `migrations/`, dan dokumen pembaikan ini ke
   repositori GitHub.
3. Selepas GitHub Pages siap, uji login, import GeoJSON/KML/KMZ, simpan bacaan
   DMA, hantar satu analisis, dan semak log cron seterusnya.

Pembersihan kekal duplikasi aset dan penukaran CRS pangkalan D1 tidak dibuat.
Kedua-duanya memerlukan pemetaan sumber/CRS yang disahkan sebelum meminda data
asal.
