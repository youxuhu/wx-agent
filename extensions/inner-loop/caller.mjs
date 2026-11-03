import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Budget,requestInputBound} from '../../experiments/inner-loop/budget.mjs';
import {parseJSON} from '../../experiments/inner-loop/measure.mjs';
import protocol from '../../experiments/inner-loop/protocol.json' with {type:'json'};
import summary from '../../experiments/inner-loop/evidence/summary.json' with {type:'json'};

// The frozen study is never written. Every new request inherits its spent budget.
export function createCaller(runtime,agentDir){
 return async(system,text,signal)=>{
  const dir=join(agentDir,'outputs','inner-loop-integration');await mkdir(dir,{recursive:true,mode:0o700});
  const lock=await open(join(dir,'budget.lock'),'wx',0o600);
  try{
   const read=async p=>readFile(p,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e});
   const previous=await read(join(dir,'budget.json'));
   const study=await read(join(agentDir,'outputs','inner-loop','run.json'));
   const floor=summary.conservativeBudget;
   for(const state of [previous,study?.budget].filter(Boolean)){
    if(!['calls','tokens','usd'].every(key=>Number.isFinite(state[key])&&state[key]>=0)||!Number.isInteger(state.calls)||!Number.isInteger(state.tokens))throw Error('Corrupt budget ledger; manual review required.');
   }
   const seed={};for(const key of ['calls','tokens','usd'])seed[key]=Math.max(floor[key],study?.budget?.[key]??0,previous?.[key]??0);
   seed.blocked=previous?.blocked===true||study?.budget?.blocked===true;
   const rt=await runtime(),model=rt.getModel(protocol.provider,protocol.model);
   if(!model||model.api!==protocol.api||new URL(model.baseUrl).hostname!=='api.deepseek.com')throw Error('Approved route unavailable.');
   const budget=new Budget(protocol.limits,model.cost,seed),input=requestInputBound(system,text);
   const persist=async()=>{const p=join(dir,'budget.json');await writeFile(p+'.tmp',JSON.stringify(budget.state,null,2)+'\n',{mode:0o600});await rename(p+'.tmp',p)};
   if(signal.aborted)throw Error('Cancelled');
   const reservation=budget.reserve(input);await persist(); // Crash/error retains full reservation.
   try{
    const stream=rt.streamSimple(model,{systemPrompt:system,messages:[{role:'user',content:text,timestamp:Date.now()}]},
     {maxTokens:384,reasoning:'off',temperature:0.2,maxRetries:0,timeoutMs:60000,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),
      onPayload:p=>{if(Buffer.byteLength(JSON.stringify(p.messages))+64>input)throw Error('Wire input bound exceeded');return {...p,thinking:{type:'disabled'},max_tokens:384,response_format:{type:'json_object'}}}});
    for await(const _ of stream){}const final=await stream.result();
    if(['error','aborted'].includes(final.stopReason))throw Error('Provider error or cancellation; reservation retained.');
    if(final.model!==model.id||final.content.some(c=>c.type==='thinking'&&c.thinking?.length))throw Error('Unexpected response.');
    const u=final.usage;
    budget.settle(reservation,u?{input:u.input+u.cacheRead+u.cacheWrite,output:u.output}:null);
    return final.stopReason==='stop'?parseJSON(final.content.filter(c=>c.type==='text').map(c=>c.text).join('')):null;
   }finally{await persist()}
  }finally{await lock.close();await unlink(join(dir,'budget.lock'))}
 };
}
