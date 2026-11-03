import {actSystem} from '../assistants/inner/play-loop.mjs';
import {core} from './helpers.mjs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const {createAssistantMessageEventStream}=await import(pathToFileURL(join(core,'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
export async function fixture(sdk,root,options={}){
 const rt=await sdk.ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:null,modelsStorePath:join(root,'models.json'),allowModelNetwork:false,refreshOnCreate:false});
 rt.registerProvider('inner-fixture',{baseUrl:'https://fixture.invalid',api:'inner-fixture-api',apiKey:'synthetic',models:[{id:'conversation',name:'Local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:options.contextWindow??8192,maxTokens:options.maxTokens??512}],streamSimple:(model,context,request)=>{
  options.capture?.({model,context,request});const custom=options.result?.(context)??{};
  const s=createAssistantMessageEventStream(),m={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:custom.content??[{type:'text',text:custom.text??'我听到了，我们可以接着聊。'}],stopReason:custom.stopReason??'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{s.push({type:'start',partial:m});s.push({type:'done',reason:m.stopReason,message:m});s.end()});return s;
 }});return rt;
}
export function activity(){let index=0;const messages=['我在试写一个门把手的故事。',null,'我给故事加了一次轻轻敲门。',null,'故事里它终于等到了回应。'];return async system=>{
 if(system===actSystem)return index>=5?{action:'rest',path:null,text:null,question:'当前作品已完成',expected:'休息',message:null,next:null}:{action:'write',path:`story-${index}.md`,text:`门把手的故事第${index}段：${['听见声音','分辨脚步','一次敲门','等待片刻','得到回应'][index]}。`,question:`发展故事第${index}段`,expected:'增加具体故事情节',message:messages[index],next:index===4?null:'发展下一段故事'};
 const n=index++;return {progress:true,kind:'creation',summary:`第${n}段增加了一个具体情节`,share:!!messages[n],reason:'本地可控例子',continue:n<4};
 }}
