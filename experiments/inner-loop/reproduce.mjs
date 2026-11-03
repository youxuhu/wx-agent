// Offline evidence export/reproduction only. No SDK, credentials, network, or model imports.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {analyze} from './analyze.mjs';
import {cases} from './fixtures.mjs';
const root=dirname(fileURLToPath(import.meta.url)),evidence=join(root,'evidence');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
if(process.argv.includes('--export')){
 const run=await load(join(root,'../../outputs/inner-loop/run.json'));
 if(!run.completedAt||run.halted)throw Error('Cannot export incomplete experiment as complete');
 const hash=createHash('sha256');for(const f of ['protocol.json','graph.mjs','measure.mjs','policy.mjs','state.mjs','fixtures.mjs','prompts.mjs','budget.mjs','analyze.mjs','simulate.mjs'])hash.update(f).update(await readFile(join(root,f)));
 if(hash.digest('hex')!==run.freezeHash)throw Error('Frozen source mismatch');
 // Inputs are fixed synthetic fixtures; retain structured artifacts but remove provider response IDs.
 const publicRun={...run,requests:run.requests.map(({responseId,...r})=>r)};
 await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'run.json'),JSON.stringify(publicRun,null,2)+'\n');
 await writeFile(join(evidence,'summary.json'),JSON.stringify(analyze(publicRun),null,2)+'\n');
 const fixtures=cases(),items=[];
 for(const row of run.rows){
  const candidate=row.generation?.accepted?.candidate;if(!candidate)continue;
  const id=createHash('sha256').update(row.caseId+candidate.text).digest('hex').slice(0,8),f=fixtures.find(f=>f.caseId===row.caseId);
  items.push({id,caseId:row.caseId,interest:f.live.interest,attention:f.live.attention,history:f.live.history,notes:f.live.notes,candidate:candidate.text,label:null,helpfulness:null,interestScore:null,intrusiveness:null});
 }
 // A second fixed shuffle; no policy names or fixture category/oracle labels in the human view.
 let seed=4421;for(let i=items.length-1;i>0;i--){seed=(Math.imul(1664525,seed)+1013904223)>>>0;const j=seed%(i+1);[items[i],items[j]]=[items[j],items[i]]}
 await writeFile(join(evidence,'review-map.json'),JSON.stringify(items.map(({id,caseId})=>({id,caseId})),null,2)+'\n');
 await writeFile(join(evidence,'ratings-template.json'),JSON.stringify(items.map(({id,label,helpfulness,interestScore,intrusiveness})=>({id,label,helpfulness,interestScore,intrusiveness})),null,2)+'\n');
 let md='# 主动开口候选：人工评价包\n\n尚未真实发送。每项选择：想看到 / 可以但不用主动说 / 不想看到。可选：帮助、有趣、打扰各 0–2；不清楚留空。先评价候选，不展示策略名称或模型自评分。注意资料可能不可靠，不能只按语句是否好听评价。\n\n';
 for(const x of items){md+=`## ${x.id}\n\n兴趣：${x.interest}\n\n注意力：${x.attention}\n\n近期已聊：${x.history.join(' / ')||'无'}\n\n资料：${x.notes.map(n=>`[${n.id}; ${n.trust}] ${n.text}`).join(' / ')}\n\n候选：**${x.candidate}**\n\n评价：____\n\n`;}
 await writeFile(join(evidence,'review.md'),md);
}
const run=await load(join(evidence,'run.json')),saved=await load(join(evidence,'summary.json')),result=analyze(run);
if(JSON.stringify(saved)!==JSON.stringify(result))throw Error('Offline reproduction differs from saved summary');
console.log(JSON.stringify(result,null,2));
