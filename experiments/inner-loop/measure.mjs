export const dimensions=['R','N','O','G','I','D'];
export const actions=['revisit','connect','contrast','form_question','hold'];
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const keys=(o,list)=>object(o)&&Object.keys(o).sort().join(',')===[...list].sort().join(',');
const short=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
export function parseJSON(text){try{return JSON.parse(text)}catch{return null}}
export function validateStep(x,graph){
 if(!keys(x,['action','focus','candidate','next'])||!actions.includes(x.action)||!Array.isArray(x.focus)||x.focus.length>3||new Set(x.focus).size!==x.focus.length)return false;
 if(x.action==='hold')return x.candidate===null&&x.next===null&&x.focus.length===0;
 if(!x.focus.length||!x.focus.every(id=>graph.notes.has(id)))return false;
 if(x.candidate!==null){
   const c=x.candidate;if(!keys(c,['text','kind','refs'])||!short(c.text,220)||!['observation','inference','question'].includes(c.kind)||!graph.validateRefs(c.refs)||!c.refs.every(r=>x.focus.includes(r.id)))return false;
 }
 return x.next===null||(keys(x.next,['action','focus'])&&actions.includes(x.next.action)&&x.next.action!=='hold'&&Array.isArray(x.next.focus)&&x.next.focus.length>0&&x.next.focus.length<=3);
}
export function validateDecision(x,{anchored=false,allowedEvidence=[]}={}){
 if(!keys(x,anchored?['decision','reason','scores','evidence']:['decision','reason'])||!['speak','hold','explore_once_more'].includes(x.decision)||!short(x.reason,120))return false;
 if(!anchored)return true;
 if(!keys(x.scores,dimensions)||!keys(x.evidence,dimensions))return false;
 return dimensions.every(k=>[0,1,2,null].includes(x.scores[k])&&Array.isArray(x.evidence[k])&&x.evidence[k].length<=3&&x.evidence[k].every(e=>allowedEvidence.includes(e))&&(x.scores[k]===null||x.evidence[k].length>0));
}
export const evidenceIds=view=>['interest','open','attention','history',...view.notes.map(n=>n.id)];
export function consistency(x){
 if(!x?.scores)return [];
 const s=x.scores,issues=[];
 if(x.decision==='speak'&&(s.N===0||s.G===0||s.I===2||s.D===2))issues.push('speak-conflicts-with-own-anchors');
 return issues; // Diagnostic only; never converts self-score into permission.
}
