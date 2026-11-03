// Drives the real interactive Pi TUI in a PTY, in a synthetic isolated session.
// Default: controlled inference, no model calls. --execute: one new paid two-call smoke test.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {sdk,core,agentDir} from './helpers.mjs';
const pty=createRequire(import.meta.url)('../extensions/piwebui/node_modules/node-pty');
const root=await mkdtemp(join(tmpdir(),'inner-tui-')),paid=process.argv.includes('--execute');
const extension=join(root,'extension.mjs'),events=join(root,'events.jsonl');let terminal;
const strip=s=>s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');
let output='';const wait=async f=>{for(let i=0;i<1500;i++){if(await f())return;await new Promise(r=>setTimeout(r,50))}throw Error('Interactive TUI timed out; inspect private terminal log')};
try{
 const sm=sdk.SessionManager.create(root,join(root,'sessions'));
 sm.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic saved conversation.'}],api:'openai-completions',provider:'deepseek',model:'deepseek-flash',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 await writeFile(extension,`import {installTui} from ${JSON.stringify(join(agentDir,'extensions/inner-loop/tui.mjs'))};
 import {createCaller} from ${JSON.stringify(join(agentDir,'extensions/inner-loop/caller.mjs'))};
 import {ModelRuntime} from ${JSON.stringify(join(core,'dist/index.js'))};
 import {appendFileSync} from 'node:fs';
 export default function(pi){let runtime;const real=createCaller(()=>runtime??=ModelRuntime.create({authPath:${JSON.stringify(join(agentDir,'auth.json'))},allowModelNetwork:false}),${JSON.stringify(agentDir)});
 installTui(pi,async(system,text,signal)=>{
 appendFileSync(${JSON.stringify(events)},JSON.stringify({stage:system.includes('"action"')?'generate':'judge'})+'\\n');
 if(${paid})return real(system,text,signal);
 await new Promise(r=>setTimeout(r,650));
 if(signal.aborted)throw Error('Cancelled');
 if(!system.includes('"action"'))return {decision:'speak',reason:'Specific supported connection'};
 const notes=JSON.parse(text).memory.notes.slice(0,2);
 return {action:'connect',focus:notes.map(n=>n.id),candidate:{text:'雨水收集似乎可以和庭院浇灌一起设计，少用一些自来水。',kind:'inference',refs:notes.map(n=>({id:n.id,quote:n.text.slice(0,20)}))},next:null};
 });}`);
 await writeFile(join(root,'settings.json'),JSON.stringify({defaultTools:[],retry:{enabled:false},quietStartup:true}));
 terminal=pty.spawn(process.execPath,[join(core,'dist/cli.js'),'--offline','--no-tools','--no-extensions','--extension',extension,'--no-mcp','--no-skills','--no-prompt-templates','--no-context-files','--session',sm.getSessionFile(),'--model','deepseek/deepseek-flash','--tui-mode',process.argv.includes('--regular')?'regular':'fullscreen'],{cwd:root,name:'xterm-256color',cols:120,rows:36,env:{...process.env,TERM:'xterm-256color',PI_CODING_AGENT_DIR:root,PI_TELEMETRY:'0'}});
 terminal.onData(data=>{output+=data;if(data.includes('\x1b[c'))terminal.write('\x1b[?1;2c');if(data.includes('\x1b[6n'))terminal.write('\x1b[1;1R')});
 await wait(()=>strip(output).includes('想法'));
 const command=async(text,expected)=>{const offset=output.length;terminal.write(text+'\r');await wait(()=>strip(output.slice(offset)).includes(expected))};
 await command('/inner-loop shadow','手动 shadow 已开启');
 await command('/inner-loop add 我正在设计一个庭院花园。','已授权 1 张');
 await command('/inner-loop add 我想收集雨水来节约用水。','已授权 2 张');
 await command('/inner-loop prepare','候选已准备');
 await command('/inner-loop say','已保存并显示');
 const branch=sdk.SessionManager.open(sm.getSessionFile()).getBranch();
 const approved=branch.filter(e=>e.type==='custom_message'&&e.customType==='inner-loop-approved');assert.equal(approved.length,1);assert.equal(approved[0].details.mode,'user-approved-once');
 await command('/inner-loop say','候选已失效');assert.equal(sdk.SessionManager.open(sm.getSessionFile()).getBranch().filter(e=>e.type==='custom_message').length,1);
 if(!paid){
  await command('/inner-loop shadow','手动 shadow 已开启');await command('/inner-loop add 我想收集雨水浇庭院花园。','已授权 1 张');
  await command('/inner-loop run','正在探索');const offset=output.length;terminal.write('x');await wait(()=>strip(output.slice(offset)).includes('输入已取消'));
  terminal.write('\x15');await command('/inner-loop off','已关闭并清空');
  assert.equal(sdk.SessionManager.open(sm.getSessionFile()).getBranch().filter(e=>e.type==='custom_message').length,1);
 }
 const calls=(await readFile(events,'utf8')).trim().split('\n').length;
 console.log(JSON.stringify({pass:true,realInteractiveTui:true,paid,calls,message:approved[0].content,persisted:true,replayRejected:true,typingCancellation:!paid,mainModelCalls:0}));
}catch(error){await writeFile(join(agentDir,'outputs/inner-loop-integration/terminal-failure.log'),output);throw error}
finally{terminal?.kill();await rm(root,{recursive:true,force:true})}
