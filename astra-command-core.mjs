import {extractBasicInputsFromCommand} from './astra-field-core.mjs';

// A transparent local TEST router. This is deliberately not an LLM or an operational agent.
export function planAstraTestCommand(instruction) {
  const text=String(instruction||'').trim();
  if(!text||text.length>2000)throw new Error('Arahan perlu 1–2000 aksara.');
  const basic=extractBasicInputsFromCommand(text);
  const exactPipe=text.match(/\bSYNTH-S5-900\b/i)?.[0].toUpperCase()||null;
  const requested={
    basic:/\b(kira|calculate|flow|aliran|pressure|tekanan|hidraulik|hydraulic)\b/i.test(text),
    model:/\b(model\w*|pemodelan|hidraulik|hydraulic|calibr\w*|kalibr\w*|reserve|kapasiti|leak\w*|kebocoran)\b/i.test(text),
    calibration:/\b(calibr\w*|kalibr\w*)\b/i.test(text),
    reserve:/\b(reserve|margin|kapasiti)\b/i.test(text),
    leak:/\b(leak\w*|kebocoran|bocor)\b/i.test(text),
    map3d:/\b(3d|cesium|three\.js|miniature)\b/i.test(text)
  };
  const missing=[];
  if(requested.model&&!exactPipe)missing.push('Pipe ID TEST tepat SYNTH-S5-900; nama kawasan sahaja tidak cukup untuk memilih aset.');
  if(requested.basic&&(basic.diameterMm===null||basic.flow===null||basic.pressure===null))
    missing.push('Pengiraan asas memerlukan diameter, aliran dengan unit dan tekanan gauge dengan unit.');
  return {exactPipe,basic,requested,missing,kind:'DETERMINISTIC_TEST_ROUTER'};
}
