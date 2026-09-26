// Review records are proposals/evidence only. No path here mutates pipe GIS.
const REVIEW_STATUSES=new Set(['UNRESOLVED','AUTO_SUGGESTED','MANUAL_REVIEW_REQUIRED','VERIFIED','IGNORED_WITH_REASON']);
const enc=new TextEncoder();
async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',enc.encode(value));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}

export async function reviewableTopologyIssues(importId,audit){
  if(!importId||!audit?.issues)throw new Error('Import dan audit topologi diperlukan.');
  const detail=[...audit.issues.filter(i=>i.segmentKey),
    ...audit.nearMisses.map(i=>({code:'NEAR_MISS_ENDPOINTS',segmentKey:i.a,relatedSegmentKey:i.b,distanceMeters:i.distanceMeters,severity:'WARNING'})),
    ...audit.intersections.map(i=>({code:i.code,segmentKey:i.a,relatedSegmentKey:i.b,severity:'WARNING'}))];
  const result=[];
  for(const issue of detail){
    const evidence={...issue};
    const id=await digest(JSON.stringify([importId,issue.code,issue.segmentKey||null,issue.relatedSegmentKey||null,issue.distanceMeters??null]));
    result.push({importId,issueId:id,issueType:issue.code,severity:issue.severity||'WARNING',segmentKey:issue.segmentKey||null,
      relatedSegmentKey:issue.relatedSegmentKey||null,evidence,issueStatus:'UNRESOLVED'});
  }
  return result.sort((a,b)=>a.issueId.localeCompare(b.issueId));
}

export function reviewedIssue(issue,{status,reason='',reviewedBy='',reviewedAt=''}={}){
  if(!REVIEW_STATUSES.has(status))throw new Error('Status semakan tidak sah.');
  if(status==='IGNORED_WITH_REASON'&&!String(reason).trim())throw new Error('Sebab wajib jika isu diabaikan.');
  if(status==='VERIFIED'&&(!String(reviewedBy).trim()||!Number.isFinite(Date.parse(reviewedAt))))throw new Error('Pengesahan jurutera dan masa wajib.');
  if(status==='AUTO_SUGGESTED'&&issue.issueType==='MISSING_PIPE_ID'&&!issue.evidence?.verifiedMatch)throw new Error('Padanan Pipe ID tanpa bukti tidak boleh dicadangkan.');
  return {...issue,issueStatus:status,reviewReason:String(reason).trim()||null,reviewedBy:String(reviewedBy).trim()||null,reviewedAt:reviewedAt||null};
}
