import {normalize} from './playground.mjs';
import {reflectSystem,judgeSystem,reflectInput,judgeInput} from './prompts-initiative.mjs';

const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const keys=(o,list)=>object(o)&&Object.keys(o).sort().join(',')===[...list].sort().join(',');
const short=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;

export function parseJSON(text){try{const v=JSON.parse(text);return object(v)?v:null}catch{return null}}

export function validateCandidate(x){
 if(!keys(x,['candidate','kind','topicId','basis','why_now']))return false;
 if(!['related','new-topic'].includes(x.kind))return false;
 if(!short(x.why_now,70))return false;
 if(!Array.isArray(x.basis)||x.basis.length<1||x.basis.length>4||!x.basis.every(b=>typeof b==='string'&&b.length>1&&b.length<=80))return false;
 if(x.candidate===null)return x.kind==='related'&&x.topicId===null;
 if(!short(x.candidate,80))return false;
 if(x.kind==='new-topic')return typeof x.topicId==='string'&&x.topicId.length>1&&x.topicId.length<=80;
 return x.topicId===null;
}

export function validateJudge(x,evidenceIds){
 if(!keys(x,['decision','reason','scores','evidence']))return false;
 if(!['speak','hold'].includes(x.decision)||!short(x.reason,100))return false;
 const dims=['R','N','O','G','I','D'];
 if(!keys(x.scores,dims)||!keys(x.evidence,dims))return false;
 return dims.every(k=>[0,1,2,null].includes(x.scores[k])&&Array.isArray(x.evidence[k])&&x.evidence[k].length<=3&&x.evidence[k].every(e=>evidenceIds.includes(e))&&((x.scores[k]===null||x.scores[k]===0)||x.evidence[k].length>0));
}

const DEDUPE_MIN=6;
export function overlaps(candidate,texts,min=DEDUPE_MIN){
 const a=normalize(candidate);if(!a)return false;
 return texts.some(t=>{const b=normalize(t);if(!b)return false;
  if(a===b)return true;
  const [shorter,longer]=a.length<=b.length?[a,b]:[b,a];
  for(let i=0;i+min<=shorter.length;i++)if(longer.includes(shorter.slice(i,i+min)))return true;
  return false});
}

/** Deterministic pre-model gates. Returns a hold reason or null. */
export function hardGate({candidate,topic,mode='related',said=[],recentAssistant='',attention='unknown',quotaOK=true,canDeliver=true}){
 if(!candidate)return 'no-candidate';
 if(mode==='new-topic'&&!topic?.id)return 'no-topic';
 if(!quotaOK)return 'quota';
 if(!canDeliver)return 'not-idle';
 if(attention!=='idle')return 'attention';
 if(overlaps(candidate,[recentAssistant,...said]))return 'duplicate';
 return null;
}

export function judgeGate(x){
 if(!x)return 'invalid-judge';
 if(x.decision!=='speak')return 'model-hold';
 const s=x.scores;
 if(s.I===2||s.D===2||s.N===0||s.G===0)return 'model-hold';
 return null;
}

const asObject=v=>object(v)?v:parseJSON(typeof v==='string'?v:'');

export async function generateCandidate(call,{reason='user-turn',ordinaryReply='',conversation=[],memories=[],topics=[],said=[],allowNewTopic}={}){
 const raw=await call(reflectSystem,reflectInput({reason,ordinaryReply,conversation,memories,topics,said,allowNewTopic}));
 const x=asObject(raw);
 return validateCandidate(x)?x:null;
}

export async function judge(call,{candidate,topic,memories=[],said=[],attention='unknown'}={}){
 const input=judgeInput({candidate,topic,memories,said,attention});
 const evidenceIds=JSON.parse(input).evidenceIds;
 const raw=await call(judgeSystem,input);
 const x=asObject(raw);
 return {decision:x,valid:validateJudge(x,evidenceIds)};
}
