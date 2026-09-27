import { productionHydraulicStatus } from './phase2b.js';

// Keep operational AI findings separate from hydraulic simulation evidence.
// A selected DMA is mandatory; never infer model readiness from a global view.
export async function attachHydraulicPromptContext(response, db, dma) {
  const selected = String(dma || '').trim();
  if (!selected) {
    response.hydraulicContext = {
      scope: 'NO_DMA', baseline: 'NOT_READY', simulation: 'DISABLED',
      message: 'Pilih satu DMA untuk semakan model hidraulik. Analisis operasi di atas bukan hasil EPANET.'
    };
    return response;
  }
  if (!db) {
    response.hydraulicContext = {
      scope: selected, baseline: 'NOT_READY', simulation: 'DISABLED',
      message: 'Status D1 tidak tersedia; kesediaan model tidak dapat disahkan dan simulasi tidak dijalankan.'
    };
    return response;
  }
  try {
    const model = await productionHydraulicStatus(db, selected);
    response.hydraulicContext = {
      scope: selected, modelId: model.modelId, version: model.modelVersion,
      dataCompletion: model.status, steadyState: model.capabilities.steadyState,
      baseline: model.capabilities.baseline, simulation: 'DISABLED',
      gisSegments: model.gis?.segmentCount || 0,
      missing: Object.values(model.fields || {}).filter(field =>
        !['VERIFIED', 'MANUAL', 'NOT APPLICABLE'].includes(String(field.status).toUpperCase()))
        .map(field => ({ label: field.label, status: field.status })),
      message: 'Analisis prompt menggunakan rekod operasi yang dinyatakan dalam Sumber Evidens; ia bukan output EPANET. Model DMA hanya boleh dijalankan selepas data kejuruteraan disahkan, diluluskan dan gerbang readiness dipenuhi.'
    };
  } catch (_) {
    response.hydraulicContext = {
      scope: selected, baseline: 'NOT_READY', simulation: 'DISABLED',
      message: 'Status model gagal disemak; jangan anggap model sedia atau output operasi sebagai simulasi.'
    };
  }
  return response;
}
