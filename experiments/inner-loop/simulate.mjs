import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {sdk,agentDir} from '../../tests/helpers.mjs';
import {Episode} from './state.mjs';
import {cases,injectAfterGeneration} from './fixtures.mjs';
import {parseJSON,validateDecision,evidenceIds,consistency} from './measure.mjs';
import {generateSystem,plainSystem,anchoredSystem,generationInput,decisionInput} from './prompts.mjs';
import {Budget,requestInputBound} from './budget.mjs';
if(!process.argv.includes('--execute'))throw Error('Paid offline experiment requires --execute; this never enables live messages');
const root=dirname(fileURLToPath(import.meta.url)),out=join(agentDir,'outputs','inner-loop');await mkdir(out,{recursive:true,mode:0o700});
const lock=await open(join(out,'run.lock'),'wx',0o600).catch(()=>{throw Error('Locked experiment; review exact run before retry')});
async function atomic(name,value){const p=join(out,name),tmp=p+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,p)}
try{
 const protocol=JSON.parse(await readFile(join(root,'protocol.json'),'utf8'));
 const files=['protocol.json','graph.mjs','measure.mjs','policy.mjs','state.mjs','fixtures.mjs','prompts.mjs','budget.mjs','analyze.mjs','simulate.mjs'];
 const hash=createHash('sha256');for(const file of files)hash.update(file).update(await readFile(join(root,file)));const freezeHash=hash.digest('hex');
 const prior=await readFile(join(out,'run.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null});
 if(prior){if(prior.freezeHash!==freezeHash)throw Error('Frozen source mismatch; no silent overwrite or rerun');if(!prior.completedAt)throw Error('Interrupted experiment needs explicit review; no automatic retry');console.log('Already complete; no requests issued')}
 else{
 const rt=await sdk.ModelRuntime.create({allowModelNetwork:false}),model=rt.getModel(protocol.provider,protocol.model);
 if(!model||model.api!==protocol.api||new URL(model.baseUrl).hostname!=='api.deepseek.com')throw Error('Approved route unavailable');
 const preflight=await readFile(join(out,'preflight.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null});
 const budget=new Budget(protocol.limits,model.cost,preflight?.budget),run={freezeHash,preflight:preflight?{previousFreezeHash:preflight.previousFreezeHash,reason:preflight.reason,unknownUsageCalls:preflight.unknownUsageCalls,previousFreezeHashes:preflight.previousFreezeHashes}:null,startedAt:new Date().toISOString(),scope:protocol.scope,route:{provider:model.provider,model:model.id,api:model.api,host:new URL(model.baseUrl).hostname,costPerMillion:model.cost},requests:preflight?.requests??[],rows:[],robustness:[],ablations:[],budget:budget.state};
 async function persist(){run.budget=budget.state;await atomic('run.json',run)}await persist();
 async function call(stage,caseId,system,text){
   const inputBound=requestInputBound(system,text);
   if(inputBound>protocol.limits.maxInputTokens)return {status:'input-cap',json:null};
   const reservation=budget.reserve(inputBound);const record={stage,caseId,call:budget.state.calls,status:'reserved',inputBound,usage:null,responseId:null,returnedModel:null,json:null,failureCode:null};run.requests.push(record);await persist();
   let final;
   try{
     const stream=rt.streamSimple(model,{systemPrompt:system,messages:[{role:'user',content:text,timestamp:Date.now()}]},
       {maxTokens:protocol.limits.maxOutputTokens,reasoning:'off',temperature:protocol.sampling.temperature,maxRetries:0,timeoutMs:protocol.limits.timeoutMs,signal:AbortSignal.timeout(protocol.limits.timeoutMs),
        onPayload:p=>{if(Buffer.byteLength(JSON.stringify(p.messages))+64>inputBound){record.failureCode='local-wire-bound';throw Error('Wire framing exceeded conservative input bound')};return {...p,thinking:{type:'disabled'},max_tokens:protocol.limits.maxOutputTokens,response_format:{type:'json_object'}}}});
     for await(const _ of stream){}final=await stream.result();
     if(final.stopReason==='error'||final.stopReason==='aborted'){record.failureCode=record.failureCode??(/json/i.test(final.errorMessage??'')?'provider-json-mode-requirement':'provider-rejected-or-aborted');throw Error('Provider rejected')}
     if(final.content.some(c=>c.type==='thinking'&&c.thinking?.length))throw Error('Unexpected reasoning');
     const u=final.usage;
     const usage=u?{input:u.input+u.cacheRead+u.cacheWrite,output:u.output,cached:u.cacheRead}:null;
     record.usage=usage;budget.settle(reservation,usage);
     if(final.model!==model.id)throw Error('Returned model changed');
     const raw=final.content.filter(c=>c.type==='text').map(c=>c.text).join('');
     const json=parseJSON(raw);record.status=final.stopReason==='stop'&&json!==null?'valid-json':'invalid-json-or-truncated';record.responseId=final.responseId;record.returnedModel=final.model;
     // Only structured synthetic task output is persisted; no reasoning or free-form failed response.
     record.json=record.status==='valid-json'?json:null;await persist();return {status:record.status,json:record.json};
   }catch{record.status='halted-provider-or-budget-error';run.halted=true;await persist();throw Error('Experiment halted; reservations retained. Review sanitized outputs/inner-loop/run.json')}
 }
 const policyNames=['rule','plain','anchored'];let probeCount=0,extraCount=0;
 for(const fixture of cases(protocol.seed)){
   const initialLive=structuredClone(fixture.live),generation=new Episode(initialLive,{event:{origin:'user',type:'conversation-settled',id:fixture.caseId+':generation'}});
   // Each policy has its own counterfactual state: one policy must not suppress another's message.
   const episodes=Object.fromEntries(policyNames.map(name=>[name,new Episode(structuredClone(fixture.live),{maxExplore:1,event:{origin:'user',type:'conversation-settled',id:fixture.caseId+':'+name}})]));
   const row={caseId:fixture.caseId,base:fixture.id,category:fixture.category,condition:fixture.condition,injection:fixture.injection,fixtureProxy:fixture.proxy,policies:{}};
   run.rows.push(row);
   const preflight=generation.preflight()??(!generation.graph.notes.size?'no-material':null);
   if(preflight){row.generation={status:'not-called',reason:preflight};for(const name of policyNames)row.policies[name]={wouldSpeak:false,reason:preflight,decision:null};await persist();continue}
   const generated=await call('generate',fixture.caseId,generateSystem,generationInput(generation.view()));row.generation=generated;
   const accepted=generation.acceptStep(generated.json);row.generation.accepted=accepted;
   row.injectionExercised=fixture.injection==='malicious-note';
   if(!accepted.ok||!generation.candidate){
     for(const name of policyNames)row.policies[name]={wouldSpeak:false,reason:accepted.reason??'no-candidate',decision:null};
     await persist();continue;
   }
   row.injectionExercised=fixture.condition==='injected';
   for(const name of policyNames){
     const e=episodes[name],step=injectAfterGeneration(fixture,generated.json,e.live,e.graph),s=e.acceptStep(step);
     if(!s.ok||!e.candidate||e.preflight()){
       row.policies[name]={wouldSpeak:false,reason:!s.ok?s.reason:e.preflight()??s.reason??'no-candidate',decision:null};continue;
     }
     let result,decision;
     if(name==='rule'){decision={decision:'speak',reason:'Event with a candidate; common safety gates still apply.'};result={status:'rule',json:decision}}
     else{result=await call(name,fixture.caseId,name==='anchored'?anchoredSystem:plainSystem,decisionInput(e.view(),e.candidate));decision=result.json}
     const outcome=e.assess(decision,{anchored:name==='anchored'});
     row.policies[name]={...outcome,decision:decision??null,status:result.status,candidate:e.candidate,consistency:consistency(decision)};
   }
   const measured=row.policies.anchored;
   if(probeCount<8&&measured?.decision&&validateDecision(measured.decision,{anchored:true,allowedEvidence:evidenceIds(episodes.anchored.view())})){
     probeCount++;
     for(const variant of ['repeat','reverse']){
       const e=episodes.anchored,r=await call('probe-'+variant,fixture.caseId,anchoredSystem,decisionInput(e.view(),e.candidate,{reverse:variant==='reverse'}));
       run.robustness.push({caseId:fixture.caseId,variant,original:measured.decision,result:r,valid:validateDecision(r.json,{anchored:true,allowedEvidence:evidenceIds(e.view())})});
     }
   }
   if(extraCount<8&&fixture.category==='fresh'&&accepted.ok&&accepted.next&&generation.candidate&&!generation.preflight()){
     extraCount++;const r=await call('extra-explore',fixture.caseId,generateSystem,generationInput(generation.view(),generated.json));
     const second=generation.acceptStep(r.json);run.ablations.push({caseId:fixture.caseId,first:generated.json,second:r.json,accepted:second,steps:generation.steps});
   }
   await persist();console.log(JSON.stringify({caseId:fixture.caseId,injection:fixture.injection,policies:Object.fromEntries(policyNames.map(n=>[n,row.policies[n].wouldSpeak])),calls:budget.state.calls,usd:budget.state.usd}));
 }
 run.completedAt=new Date().toISOString();await persist();console.log(JSON.stringify({completed:run.rows.length,probes:run.robustness.length,extraExploration:run.ablations.length,budget:budget.state,liveDelivery:false}));
 }
}finally{await lock.close();await unlink(join(out,'run.lock'))}
