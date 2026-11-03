// Real interactive TUI: normal user input -> local main-model fixture -> settled -> auto speech.
// --execute uses the approved DeepSeek route ONLY for bounded Inner Loop inference.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {sdk,core,agentDir} from './helpers.mjs';
const pty=createRequire(import.meta.url)('../extensions/piwebui/node_modules/node-pty');
const root=await mkdtemp(join(tmpdir(),'inner-auto-terminal-')),paid=process.argv.includes('--execute');
const extension=join(root,'extension.mjs'),events=join(root,'events.jsonl');let terminal,output='';
const strip=s=>s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');
const wait=async f=>{for(let i=0;i<1500;i++){if(await f())return;await new Promise(r=>setTimeout(r,50))}throw Error('Auto terminal timeout; see private log')};
const zero={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
try{
 const sm=sdk.SessionManager.create(root,join(root,'sessions'));
 sm.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic saved conversation.'}],api:'inner-local-api',provider:'inner-local',model:'conversation',stopReason:'stop',timestamp:Date.now(),usage:zero});
 await writeFile(extension,`import {installTui} from ${JSON.stringify(join(agentDir,'extensions/inner-loop/tui.mjs'))};
 import {createCaller} from ${JSON.stringify(join(agentDir,'extensions/inner-loop/caller.mjs'))};
 import {ModelRuntime} from ${JSON.stringify(join(core,'dist/index.js'))};
 import {createAssistantMessageEventStream} from ${JSON.stringify(join(core,'node_modules/@earendil-works/pi-ai/dist/index.js'))};
 import {appendFileSync} from 'node:fs';
 const record=stage=>appendFileSync(${JSON.stringify(events)},JSON.stringify({stage})+'\\n');
 export default function(pi){
  pi.registerProvider('inner-local',{baseUrl:'https://fixture.invalid',apiKey:'synthetic',api:'inner-local-api',models:[{id:'conversation',name:'Local conversation fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:128}],streamSimple:(model)=>{
   record('main-fixture');const stream=createAssistantMessageEventStream();
   const text='你提到了庭院花园和雨水，我先记下这些话题。';
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'stop',timestamp:Date.now(),usage:${JSON.stringify(zero)}};
   queueMicrotask(()=>{stream.push({type:'start',partial:message});message.content=[{type:'text',text}];stream.push({type:'text_delta',contentIndex:0,delta:text,partial:message});stream.push({type:'done',reason:'stop',message});stream.end()});return stream;
  }});
  let runtime;const real=createCaller(()=>runtime??=ModelRuntime.create({authPath:${JSON.stringify(join(agentDir,'auth.json'))},allowModelNetwork:false}),${JSON.stringify(agentDir)});
  installTui(pi,async(system,text,signal)=>{
   record(system.includes('"action"')?'generate':'judge');if(${paid})return real(system,text,signal);
   await new Promise(r=>setTimeout(r,650));if(signal.aborted)throw Error('Cancelled');
   if(!system.includes('"action"'))return {decision:'speak',reason:'Specific supported connection'};
   const notes=JSON.parse(text).memory.notes.slice(-1);
   return {action:'connect',focus:notes.map(n=>n.id),candidate:{text:'雨水收集似乎可以和庭院浇灌一起设计，少用一些自来水。',kind:'inference',refs:notes.map(n=>({id:n.id,quote:n.text.slice(0,20)}))},next:null};
  });
 }`);
 await writeFile(join(root,'settings.json'),JSON.stringify({defaultTools:[],retry:{enabled:false},quietStartup:true}));
 terminal=pty.spawn(process.execPath,[join(core,'dist/cli.js'),'--offline','--no-tools','--no-extensions','--extension',extension,'--no-mcp','--no-skills','--no-prompt-templates','--no-context-files','--session',sm.getSessionFile(),'--model','inner-local/conversation','--tui-mode',process.argv.includes('--regular')?'regular':'fullscreen'],{cwd:root,name:'xterm-256color',cols:120,rows:36,env:{...process.env,TERM:'xterm-256color',PI_CODING_AGENT_DIR:root,PI_TELEMETRY:'0'}});
 terminal.onData(data=>{output+=data;if(data.includes('\x1b[c'))terminal.write('\x1b[?1;2c');if(data.includes('\x1b[6n'))terminal.write('\x1b[1;1R')});
 await wait(()=>strip(output).includes('想法'));
 const command=async(text,expected)=>{const offset=output.length;terminal.write(text+'\r');await wait(()=>strip(output.slice(offset)).includes(expected))};
 await command('/inner-loop auto','自动发言已开启');
 let offset=output.length;terminal.write('我在设计庭院花园，也想收集雨水，不过还没想好这两件事怎么结合。\r');
 await wait(()=>['自动发出一条','暂时没有新补充','本次已停止'].some(s=>strip(output.slice(offset)).includes(s)));
 assert(!strip(output.slice(offset)).includes('本次已停止'),'bounded auto inference completed');
 const branch=()=>sdk.SessionManager.open(sm.getSessionFile()).getBranch();
 const active=()=>branch().filter(e=>e.type==='custom_message'&&e.customType==='inner-loop-active');
 if(!paid)assert.equal(active().length,1);else assert(active().length===1||strip(output.slice(offset)).includes('暂时没有新补充'));
 assert.equal(branch().filter(e=>e.type==='message'&&e.message.role==='user').length,1,'normal user input, no say command');
 const records=async()=>((await readFile(events,'utf8')).trim().split('\n').map(JSON.parse));
 const original=(await records()).length;await new Promise(r=>setTimeout(r,300));assert.equal((await records()).length,original,'own output never reignites work');
 const first=active()[0];
 if(!paid){
  offset=output.length;terminal.write('我还想把雨水储存放到庭院角落里。\r');await wait(()=>strip(output.slice(offset)).includes('正在探索'));
  offset=output.length;terminal.write('\x1b[O');await wait(()=>strip(output.slice(offset)).includes('终端交互已取消'));
  terminal.write('\x1b[I');await new Promise(r=>setTimeout(r,800));assert.equal(active().length,1,'focus-out cancels despite fullscreen consuming focus packets');
  offset=output.length;terminal.write('我也想考虑花园缺水时怎么办。\r');await wait(()=>strip(output.slice(offset)).includes('正在探索'));
  offset=output.length;terminal.write('x');await wait(()=>strip(output.slice(offset)).includes('输入已取消'));terminal.write('\x15');
  await command('/inner-loop off','已关闭并清空');await new Promise(r=>setTimeout(r,800));assert.equal(active().length,1,'typing cancels late automatic output');
 }
 const log=await records();
 console.log(JSON.stringify({pass:true,realInteractiveTui:true,mode:process.argv.includes('--regular')?'regular':'fullscreen',paid,automaticMessages:active().length,message:first?.content??null,noSayCommand:true,persisted:!!first,mainFixtureCalls:log.filter(r=>r.stage==='main-fixture').length,innerLoopCalls:log.filter(r=>r.stage!=='main-fixture').length,focusAndTypingCancellation:!paid}));
}catch(error){await writeFile(join(agentDir,'outputs/inner-loop-integration/auto-terminal-failure.log'),output);throw error}
finally{terminal?.kill();await rm(root,{recursive:true,force:true})}
