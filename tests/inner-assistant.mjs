import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {sdk} from './helpers.mjs';import {fixture,activity} from './inner-assistant-fixture.mjs';
import {createAssistant} from '../assistants/inner/runtime.mjs';
const root=await mkdtemp(join(tmpdir(),'inner-sdk-'));let app;
try{
 await writeFile(join(root,'AGENTS.md'),'UNRELATED PRIVATE PROJECT CONTEXT');
 const rt=await fixture(sdk,root),options={profileDir:root,modelRuntime:rt,provider:'inner-fixture',model:'conversation',innerCall:activity()};
 const bind=()=>app.runtime.session.bindExtensions({mode:'tui',uiContext:{notify(){},getEditorText:()=>'',setStatus(){},onTerminalInput:()=>()=>{}}});
 app=await createAssistant(options);await bind();await app.loop.wait();
 assert.equal(app.loop.state.steps,5);assert.equal(app.loop.state.messages,3);assert.equal(app.loop.state.reason,'complete');
 assert.deepEqual(app.runtime.session.getActiveToolNames(),['play_list','play_read','play_write']);assert.deepEqual(app.runtime.services.resourceLoader.getAgentsFiles().agentsFiles,[]);assert(!app.runtime.session.systemPrompt.includes('UNRELATED PRIVATE'));
 const file=app.runtime.session.sessionFile;let saved=sdk.SessionManager.open(file);assert.equal(saved.getBranch().filter(e=>e.type==='custom_message'&&e.customType==='inner-initiative').length,3);assert(!saved.getBranch().some(e=>e.type==='message'),'startup speech has no fabricated user or assistant turn');
 await app.runtime.session.prompt('第一次实际聊天。');assert.equal(app.runtime.session.getLastAssistantText(),'我听到了，我们可以接着聊。');
 await assert.rejects(()=>createAssistant(options),/另一个进程/);
 await app.runtime.dispose();app=null;
 app=await createAssistant({...options,autoStart:false});await bind();assert.equal(app.runtime.session.sessionFile,file);assert.equal(app.loop.state.messages,3);
 await app.runtime.session.prompt('我们继续聊聊。');assert.equal(app.runtime.session.getLastAssistantText(),'我听到了，我们可以接着聊。');
 const denied=await app.runtime.session.extensionRunner.emitUserBash({type:'user_bash',command:'echo must-not-run',excludeFromContext:false,cwd:app.cwd});assert.equal(denied.result.exitCode,1);
 saved=sdk.SessionManager.open(file);assert.equal(saved.getBranch().filter(e=>e.type==='custom_message').length,3);assert(saved.getBranch().some(e=>e.type==='message'&&e.message.role==='assistant'));
 console.log('PASS: real SDK startup without input -> five actions/three persisted messages; exclusive profile; reopen -> ordinary chat preserves initiative; own-folder tools; no coding context; shell denied.');
}finally{await app?.runtime.dispose();await rm(root,{recursive:true,force:true})}
