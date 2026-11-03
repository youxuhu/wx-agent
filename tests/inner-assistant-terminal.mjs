import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createRequire} from 'node:module';
import {sdk,agentDir} from './helpers.mjs';
const pty=createRequire(import.meta.url)('../extensions/piwebui/node_modules/node-pty');
const root=await mkdtemp(join(tmpdir(),'inner-tui-')),profile=join(root,'profile'),entry=join(root,'entry.mjs');let terminal,output='',exited=false;
const strip=s=>s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');
const wait=async f=>{for(let i=0;i<600;i++){if(await f())return;await new Promise(r=>setTimeout(r,30))}throw Error('TUI timeout')};
try{
 await writeFile(entry,`import {createAssistant,loadPi} from ${JSON.stringify(join(agentDir,'assistants/inner/runtime.mjs'))};
 import {fixture,activity} from ${JSON.stringify(join(agentDir,'tests/inner-assistant-fixture.mjs'))};
 const selectedProfile=process.env.INNER_TEST_PROFILE??${JSON.stringify(profile)};process.env.PI_CODING_AGENT_DIR=selectedProfile;process.env.PI_OFFLINE='1';process.env.PI_TELEMETRY='0';
 const {sdk}=await loadPi();const app=await createAssistant({profileDir:selectedProfile,modelRuntime:await fixture(sdk,${JSON.stringify(root)}),provider:'inner-fixture',model:'conversation',innerCall:(()=>{const act=activity();return async(...args)=>{if(process.env.INNER_TEST_SLOW==='1')await new Promise(r=>setTimeout(r,500));return act(...args)}})()});
 try{await new sdk.InteractiveMode(app.runtime,{tuiMode:process.env.INNER_TEST_REGULAR==='1'?'regular':'fullscreen'}).run()}finally{await app.runtime.dispose()}`);
 const start=async(slow=false)=>{output='';exited=false;terminal=pty.spawn(process.execPath,[entry],{cwd:root,name:'xterm-256color',cols:120,rows:36,env:{...process.env,TERM:'xterm-256color',INNER_TEST_PROFILE:slow?join(root,'slow-profile'):profile,INNER_TEST_SLOW:slow?'1':'0',INNER_TEST_REGULAR:process.argv.includes('--regular')?'1':'0'}});terminal.onData(data=>{output+=data;if(data.includes('\x1b[c'))terminal.write('\x1b[?1;2c');if(data.includes('\x1b[6n'))terminal.write('\x1b[1;1R')});terminal.onExit(()=>{exited=true});await wait(()=>strip(output).includes('聊天与自主活动')||strip(output).includes('故事里它终于等到了回应'))};
 const command=async(text,expected)=>{const offset=output.length;terminal.write(text+'\r');await wait(()=>strip(output.slice(offset)).includes(expected))};
 const quit=async()=>{terminal.write('/quit\r');await wait(()=>exited);terminal=null};
 await start();await wait(()=>strip(output).includes('故事里它终于等到了回应'));
 const files=(await readdir(join(profile,'sessions'))).filter(f=>f.endsWith('.jsonl'));assert.equal(files.length,1);const file=join(profile,'sessions',files[0]);assert.equal(sdk.SessionManager.open(file).getBranch().filter(e=>e.customType==='inner-initiative').length,3);
 const state=JSON.parse(await readFile(join(profile,'activity.json'),'utf8'));assert.equal(state.steps,5);assert.equal(state.messages,3);
 await command('!touch '+join(root,'must-not-exist'),'不执行 Shell');assert(!existsSync(join(root,'must-not-exist')));
 await command('你好，我们接着聊。','我听到了');await command('/stop','已停下当前活动');await quit();
 await start();await command('继续随便聊聊。','我听到了');await quit();assert.equal(sdk.SessionManager.open(file).getBranch().filter(e=>e.customType==='inner-initiative').length,3);
 await start(true);terminal.write('正在输入');await new Promise(r=>setTimeout(r,700));assert(!existsSync(join(root,'slow-profile','playground','story-0.md')),'typing prevents late writes');assert(!strip(output).includes('[inner-initiative]'),'typing prevents late speech');terminal.write('\x15');await command('先听我说一句。','我听到了');await quit();
 console.log('PASS: real PTY '+(process.argv.includes('--regular')?'regular':'fullscreen')+' startup with zero user input -> five actions/three messages; ordinary chat; shell denial; typing rejects late writes/speech; stop; own-session reopen without duplicate speech. Local model fixture, zero paid calls.');
}catch(error){await writeFile(join(agentDir,'outputs/inner-loop-integration/assistant-terminal-failure.log'),output);throw error}finally{terminal?.kill();await rm(root,{recursive:true,force:true})}
