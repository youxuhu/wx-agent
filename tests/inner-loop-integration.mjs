import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sdk,createJiti,agentDir,core,initTheme} from './helpers.mjs';
import {pathToFileURL} from 'node:url';
import {createCaller} from '../extensions/inner-loop/caller.mjs';
const {install}=await createJiti(import.meta.url,{alias:{'@earendil-works/pi-coding-agent':join(core,'dist/index.js')}}).import('../extensions/inner-loop/index.ts');
const paid=process.argv.includes('--execute');
const root=await mkdtemp(join(tmpdir(),'inner-loop-sdk-'));
let session,controller,resolveCall,delay=false,calls=0,editor='';
const warnings=[];
const step={action:'connect',focus:['card-1','card-2'],candidate:{text:'Could a rain garden connect the courtyard and water-saving plans?',kind:'question',refs:[{id:'card-1',quote:'courtyard garden'},{id:'card-2',quote:'save rainwater'}]},next:null};
const fake=async()=>{calls++;if(delay)return new Promise(resolve=>{resolveCall=resolve});return calls%2===1?step:{decision:'speak',reason:'Connects the two explicitly provided plans.'}};
const call=paid?createCaller(()=>sdk.ModelRuntime.create({allowModelNetwork:false}),agentDir):fake;
const wait=async predicate=>{for(let i=0;i<2000;i++){if(predicate())return;await new Promise(r=>setTimeout(r,50))}throw Error('Integration timed out')};
try{
 const settings=sdk.SettingsManager.inMemory({defaultTools:[],retry:{enabled:false}});
 const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noContextFiles:true,noSkills:true,noPromptTemplates:true,disabledBuiltinExtensions:['mcp'],extensionFactories:[pi=>{controller=install(pi,call)}]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const sm=sdk.SessionManager.create(root,join(root,'sessions'));
 ({session}=await sdk.createAgentSession({cwd:root,agentDir:root,settingsManager:settings,resourceLoader:loader,sessionManager:sm,tools:[]}));
 await session.bindExtensions({mode:'tui',uiContext:{notify:(s,k)=>warnings.push([s,k]),getEditorText:()=>editor},onError:e=>{throw Error(JSON.stringify(e))}});
 assert.deepEqual(session.getActiveToolNames(),[]);
 const command=async text=>{await session.prompt(`/inner-loop ${text}`)};
 await command('status');assert.equal(controller.mode,'off');assert.equal(calls,0);
 await command('shadow');await command('add I am planning a courtyard garden.');await command('add I want to save rainwater.');
 await command('run');await wait(()=>!controller.episode);
 const result=controller.result;assert(result,'real command completed');
 const custom=sm.getBranch().filter(e=>e.type==='custom_message');
 assert.equal(custom.length,1);assert.equal(custom[0].customType,'inner-loop-shadow');assert.equal(custom[0].details.delivered,false);
 initTheme('dark');
 const {CustomMessageComponent}=await import(pathToFileURL(join(core,'dist/modes/interactive/components/custom-message.js')).href);
 const rendered=new CustomMessageComponent({...custom[0],role:'custom',timestamp:Date.now()},undefined).render(100).join('\n');
 assert(rendered.includes('Inner Loop shadow'),'native TUI renderer displays labeled preview');
 assert.equal(session.isStreaming,false);
 // SDK flushes a new file only after its first assistant message. Save a synthetic
 // assistant record to exercise native disk persistence without a main-model call.
 sm.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic persistence fixture.'}],api:'openai-completions',provider:'deepseek',model:'deepseek-flash',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 const reopened=sdk.SessionManager.open(sm.getSessionFile());
 assert.equal(reopened.getBranch().filter(e=>e.type==='custom_message'&&e.customType==='inner-loop-shadow').length,1);
 if(!paid){
  assert.equal(result.wouldSpeak,true);assert.equal(calls,2);
  editor='typing';await command('run');await new Promise(r=>setTimeout(r,0));assert.equal(calls,2);editor='';
  await command('clear');await command('shadow');await command('add I am planning a courtyard garden.');await command('add I want to save rainwater.');
  delay=true;await command('run');await wait(()=>!!resolveCall);await command('cancel');resolveCall(step);await new Promise(r=>setTimeout(r,0));assert.equal(controller.result,null);assert.equal(sm.getBranch().filter(e=>e.type==='custom_message').length,1);
  resolveCall=null;await command('run');await wait(()=>!!resolveCall);
  const oldController=controller;
  const host=new sdk.AgentSessionRuntime(session,{cwd:root,agentDir:root},async({sessionManager})=>{
   await loader.reload();const next=await sdk.createAgentSession({cwd:root,agentDir:root,settingsManager:settings,resourceLoader:loader,sessionManager,tools:[]});
   await next.session.bindExtensions({mode:'tui',uiContext:{notify:(s,k)=>warnings.push([s,k]),getEditorText:()=>editor}});
   return {...next,services:{cwd:root,agentDir:root},diagnostics:[]};
  });
  await host.newSession();session=host.session;resolveCall(step);await new Promise(r=>setTimeout(r,0));assert.equal(oldController.result,null);assert.equal(oldController.episode,null);assert.equal(controller.mode,'off');assert.equal(controller.notes.length,0);
  await session.bindExtensions({mode:'rpc'});await command('shadow');assert.equal(controller.mode,'off');
 }
 console.log(JSON.stringify({pass:true,realSDK:true,paid,shadowResult:result,mainModelCalls:0,persistence:true,cancelAndSwitch:!paid,warnings:warnings.length}));
}finally{session?.dispose();await rm(root,{recursive:true,force:true})}
