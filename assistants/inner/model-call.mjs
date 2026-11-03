import {purposeScope} from './budget.mjs';
export function jsonCaller(rt,{provider='deepseek',modelId='deepseek-flash'}={}){return async(system,text,signal,purpose='explore')=>purposeScope.run(purpose,async()=>{
 const model=rt.getModel(provider,modelId);if(!model||new URL(model.baseUrl).hostname!=='api.deepseek.com')throw Error('Approved model route unavailable');
 const source=rt.streamSimple(model,{systemPrompt:system,messages:[{role:'user',content:text,timestamp:Date.now()}]},{signal,reasoning:'off',maxRetries:0,temperature:.2,onPayload:p=>({...p,thinking:{type:'disabled'},response_format:{type:'json_object'}})});
 for await(const _ of source){}const result=await source.result();if(result.content.some(c=>c.type==='thinking'&&c.thinking))throw Error('Unexpected reasoning output');if(result.stopReason!=='stop')throw Error('Model request failed or truncated');const textOut=result.content.filter(c=>c.type==='text').map(c=>c.text).join('');return JSON.parse(textOut.replace(/^```(?:json)?\s*|\s*```$/g,''));
 })}
