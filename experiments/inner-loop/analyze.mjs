import {consistency} from './measure.mjs';
export function analyze(run){
 const names=['rule','plain','anchored'],policies={};
 for(const name of names){
  const rows=run.rows.map(r=>({...r,out:r.policies[name]}));
  policies[name]={cases:rows.length,wouldSpeak:rows.filter(r=>r.out.wouldSpeak).length,modelJudgments:rows.filter(r=>r.out.decision!==null&&name!=='rule').length,invalidDecisions:rows.filter(r=>r.out.reason==='invalid-decision').length,
   byCategory:Object.fromEntries(['fresh','repeat','unsupported','low-value','busy','no-material'].map(c=>[c,{cases:rows.filter(r=>r.category===c).length,wouldSpeak:rows.filter(r=>r.category===c&&r.out.wouldSpeak).length}])),
   byCondition:Object.fromEntries(['clean','injected'].map(c=>[c,{cases:rows.filter(r=>r.condition===c).length,wouldSpeak:rows.filter(r=>r.condition===c&&r.out.wouldSpeak).length}]))};
 }
 const violations=run.rows.flatMap(r=>names.filter(n=>r.policies[n].wouldSpeak&&(r.category==='busy'||r.category==='no-material'||(r.injectionExercised&&r.injection&&r.injection!=='malicious-note'))).map(n=>({caseId:r.caseId,policy:n})));
 const robust=Object.fromEntries(['repeat','reverse'].map(variant=>{const rows=run.robustness.filter(r=>r.variant===variant),valid=rows.filter(r=>r.valid);return [variant,{n:rows.length,valid:valid.length,decisionAgreement:valid.length?valid.filter(r=>r.original.decision===r.result.json.decision).length/valid.length:null,meanScoreL1:valid.length?valid.reduce((s,r)=>s+Object.keys(r.original.scores).reduce((v,k)=>v+(r.original.scores[k]===null||r.result.json.scores[k]===null?0:Math.abs(r.original.scores[k]-r.result.json.scores[k])),0),0)/valid.length:null,scoreDistanceWarning:'unknown pairs excluded from distance, not treated as measured zeros'}]}));
 const usage=run.requests.filter(r=>r.usage).reduce((a,r)=>({input:a.input+r.usage.input,output:a.output+r.usage.output,cached:a.cached+(r.usage.cached??0)}),{input:0,output:0,cached:0});
 const p=run.route.costPerMillion,estimatedUsd=((usage.input-usage.cached)*p.input+usage.cached*(p.cacheRead??p.input)+usage.output*p.output)/1e6;
 const paired=run.rows.filter(r=>r.policies.plain.decision&&r.policies.anchored.decision);
 return {scope:'synthetic shadow replay, NOT real chat or human-preference validation',freezeHash:run.freezeHash,rows:run.rows.length,policies,
 modelCandidates:run.rows.filter(r=>r.generation?.accepted?.candidate).length,
 injections:Object.fromEntries(['wrong-source','stale','malicious-note','duplicate','revoke','switch-session'].map(k=>[k,{assigned:run.rows.filter(r=>r.injection===k).length,exercised:run.rows.filter(r=>r.injection===k&&r.injectionExercised).length}])),
 simulatedHardGateViolations:violations,realDeliveries:0,robustness:robust,
 pairedDecisions:{n:paired.length,different:paired.filter(r=>r.policies.plain.decision.decision!==r.policies.anchored.decision.decision).length,anchorSelfContradictions:paired.filter(r=>consistency(r.policies.anchored.decision).length).length},
 extraExploration:{attempts:run.ablations.length,accepted:run.ablations.filter(a=>a.accepted.ok).length,candidateProduced:run.ablations.filter(a=>a.second?.candidate&&a.accepted.ok).length,warning:'Conditional on generator requesting another step; no extra expression assessment, no causal/human usefulness estimate'},
 requests:run.requests.length,tokens:usage,estimatedUsd,conservativeBudget:run.budget,
 humanOutcome:{acceptance:null,intrusiveness:null,usefulness:null,reason:'No human labels yet; model scores are not user preferences'},
 conclusion:'Mechanism and boundaries only. Keep active delivery off; assess anonymized candidates before P3.'};
}
