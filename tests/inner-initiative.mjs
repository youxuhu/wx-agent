import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {sdk} from './helpers.mjs';import {fixture} from './inner-assistant-fixture.mjs';
import {createAssistant} from '../assistants/inner/runtime.mjs';
import {reflectSystem,judgeSystem} from '../assistants/inner/prompts-initiative.mjs';
import {hardGate,judgeGate,overlaps,validateCandidate,validateJudge} from '../assistants/inner/initiative.mjs';
import {TopicLedger} from '../assistants/inner/topics.mjs';

// --- Deterministic gates ---
test('Hard gate: no candidate/topic, quota, attention and duplication hold before any model call',()=>{
 assert.equal(hardGate({candidate:null}),'no-candidate');
 assert.equal(hardGate({candidate:'x',mode:'new-topic',topic:null}),'no-topic');
 assert.equal(hardGate({candidate:'x',quotaOK:false}),'quota');
 assert.equal(hardGate({candidate:'x',attention:'typing'}),'attention');
 assert.equal(hardGate({candidate:'x',canDeliver:false}),'not-idle');
 assert.equal(hardGate({candidate:'门把手听见了雨声，决定先不转动',attention:'idle',said:['门把手听见了雨声,决定先不转动。']}),'duplicate');
 assert.equal(hardGate({candidate:'新句',attention:'idle',said:['别的句子']}),null);
 assert.equal(hardGate({candidate:'一个完全不同的话题',topic:{id:'t1'},said:['别的句子'],attention:'idle'}),null);
 assert.equal(hardGate({candidate:'新句',topic:{id:'t1'},said:[],attention:'idle'}),null);
 assert.equal(overlaps('我喜欢秋天,它很凉爽',['我喜欢秋天。它很凉爽']),true);
 assert.equal(overlaps('完全不同',['别的']),false);
 assert.equal(judgeGate(null),'invalid-judge');
 assert.equal(judgeGate({decision:'hold',reason:'r',scores:{},evidence:{}}),'model-hold');
 assert.equal(judgeGate({decision:'speak',reason:'r',scores:{R:2,N:2,O:1,G:1,I:0,D:0},evidence:{R:['a'],N:['a'],O:[],G:['a'],I:['attention'],D:['history']}}),null);
 assert.equal(judgeGate({decision:'speak',reason:'r',scores:{R:2,N:0,O:1,G:1,I:0,D:0},evidence:{R:['a'],N:['a'],O:[],G:['a'],I:['attention'],D:['history']}}),'model-hold');
 assert.equal(validateCandidate({candidate:null,kind:'related',topicId:null,basis:['mem:x'],why_now:'因为'}),true);
 assert.equal(validateCandidate({candidate:'新话题句',kind:'new-topic',topicId:'mem:x',basis:['mem:x'],why_now:'因为'}),true);
 assert.equal(validateCandidate({candidate:'缺依据',kind:'new-topic',topicId:null,basis:['mem:x'],why_now:'因为'}),false);
 assert.equal(validateCandidate({candidate:'多字段',kind:'related',topicId:null,basis:['mem:x'],why_now:'因为',extra:1}),false);
 assert.equal(validateJudge({decision:'speak',reason:'r',scores:{R:2,N:2,O:null,G:1,I:0,D:0},evidence:{R:['a'],N:['a'],O:[],G:['a'],I:['attention'],D:['history']}},['a','attention','history']),true);
 assert.equal(validateJudge({decision:'speak',reason:'r',scores:{R:2,N:2,O:null,G:1,I:0,D:0},evidence:{R:['bogus'],N:['a'],O:[],G:['a'],I:['attention'],D:['history']}},['a','attention','history']),false);
});

// --- Ledger ---
test('Topic ledger: seeding from memory, cooldown quota, spoken/dormant transitions',()=>{
 const dir=join(tmpdir(),'topics-'+Math.random().toString(36).slice(2));
 const ledger=new TopicLedger(dir);
 ledger.seedFromMemory([{id:'m1',kind:'open-question',text:'门把手的故事要怎么收尾？'},{id:'m2',kind:'artifact',text:'雨水花园设计草稿'},{id:'m3',kind:'preference',text:'喜欢简洁的界面'}]);
 assert.deepEqual(ledger.pick().map(t=>t.source),['open-question','artifact','preference']);
 assert.equal(ledger.add({title:'',source:'web',basis:['x']}),null);
 assert.equal(ledger.add({title:'x'.repeat(200),source:'web',basis:['x']}),null);
 assert.equal(ledger.canNewTopic({everyTurns:3,maxPerSession:2,startup:true}),true);
 ledger.markSpoken('mem:m1');assert.equal(ledger.pick().some(t=>t.id==='mem:m1'),false);
 assert.equal(ledger.canNewTopic({everyTurns:3,startup:false}),false);
 ledger.turn('a');ledger.turn('a');ledger.turn('a');
 assert.equal(ledger.canNewTopic({everyTurns:3,startup:false}),false);
 ledger.turn('b');ledger.turn('c');
 assert.equal(ledger.canNewTopic({everyTurns:3,startup:false}),true);
 for(let i=0;i<2;i++)ledger.markSpoken('mem:m2');
 assert.equal(ledger.canNewTopic({everyTurns:3,maxPerSession:2,startup:false}),false);
 const held=new TopicLedger(dir);held.markHeld('mem:m3','quota');held.markHeld('mem:m3','schema');
 assert.equal(held.pick().some(t=>t.id==='mem:m3'),false);
 rm(dir,{recursive:true,force:true});
});

// --- SDK end-to-end: self-started topic without any user input ---
test('Self-started topic on session_start, no user input; quota, dedupe, no self-ignition',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inner-topic-'));
 let app,calls=[];
 const reflectResult={candidate:'我想到一个新方向：把雨水收集和门把手的故事连起来。',kind:'new-topic',topicId:'mem:seed1',basis:['mem:seed1'],why_now:'有新依据'};
 const judgeResult={decision:'speak',reason:'有依据的新联系',scores:{R:2,N:2,O:1,G:1,I:0,D:0},evidence:{R:['interest'],N:['interest'],O:['interest'],G:['interest'],I:['attention'],D:['history']}};
 try{
  const rt=await fixture(sdk,root,{});
  const options={profileDir:root,modelRuntime:rt,provider:'inner-fixture',model:'conversation',autoStart:false,
   innerCall:async(system,text)=>{calls.push({system,text});if(system===reflectSystem){const seed=app.topics.pick()[0];return {...reflectResult,topicId:seed.id,basis:seed.basis}}if(system===judgeSystem){const input=JSON.parse(text);return {...judgeResult,evidence:{...judgeResult.evidence,R:input.evidenceIds.slice(0,1),N:input.evidenceIds.slice(0,1),G:input.evidenceIds.slice(0,1)}}}return {action:'rest',path:null,text:null,question:'',expected:'',message:null,next:null}},
   memoryCall:async()=>({memories:[]})};
  const app0=app=await createAssistant(options);
  await app.memory.remember('把雨水收集和门把手的故事连起来试试',{id:'seed1',text:'把雨水收集和门把手的故事连起来试试',quote:'把雨水收集和门把手的故事连起来试试',timestamp:Date.now()},{kind:'open-question',topic:'creative'});
  await app.runtime.session.bindExtensions({mode:'tui',uiContext:{notify(){},getEditorText:()=>'',setStatus(){},onTerminalInput:()=>()=>{}}});
  for(let i=0;i<500;i++){if(app.diagnostics.recent().some(d=>d.stage==='deliver'))break;await new Promise(r=>setTimeout(r,10))}
  console.log('DIAGERR',app.diagnostics.recent().filter(d=>d.result==='error').map(d=>d.reason).join(' | '));console.log('DIAG',JSON.stringify(app.diagnostics.recent(12)),JSON.stringify(app.topics.state.topics.map(t=>t.id)));
  const branch=app.runtime.session.sessionManager.getBranch();
  const topics=branch.filter(e=>e.type==='custom_message'&&e.details?.origin==='inner-playground');
  assert.equal(topics.length,1,'exactly one self-started topic with zero user input');
  assert.equal(calls.filter(c=>c.system===reflectSystem).length,1);
  assert.equal(calls.filter(c=>c.system===judgeSystem).length,1);
  const diags=app.diagnostics.recent();
  assert(diags.some(d=>d.stage==='deliver'&&d.result==='confirmed'),'delivery confirmed');
  assert(!branch.some(e=>e.type==='message'),'no fabricated user/assistant turns');
  // Second settle with no new user turn must not re-send (dedupe + spokenThisTurn)
  await app.runtime.session.extensionRunner.emit({type:'agent_settled',aborted:false});
  await new Promise(r=>setTimeout(r,80));
  assert.equal(app.runtime.session.sessionManager.getBranch().filter(e=>e.type==='custom_message'&&e.details?.origin==='inner-playground').length,1,'no self-ignition on repeated settle');
 }finally{await app?.runtime.dispose();await rm(root,{recursive:true,force:true})}
});

test('Quota and hold paths recorded with reasons; user turn reflection not blocked by maintenance failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inner-hold-'));
 let app;
 const judgeHold={decision:'hold',reason:'用户可能正在忙',scores:{R:2,N:2,O:0,G:1,I:1,D:0},evidence:{R:['interest'],N:['interest'],O:[],G:['interest'],I:['attention'],D:['history']}};
 try{
  const rt=await fixture(sdk,root,{});
  const options={profileDir:root,modelRuntime:rt,provider:'inner-fixture',model:'conversation',autoStart:false,
   innerCall:async(system,text)=>{if(system===reflectSystem)return {candidate:'一个补充想法。',kind:'related',topicId:null,basis:['turn:1'],why_now:'相关'};if(system===judgeSystem){const ids=JSON.parse(text).evidenceIds;return {...judgeHold,evidence:{R:ids.slice(0,1),N:ids.slice(0,1),O:[],G:ids.slice(0,1),I:['attention'],D:['history']}}}return {action:'rest',path:null,text:null,question:'',expected:'',message:null,next:null}},
   memoryCall:async()=>({memories:[]})};
  app=await createAssistant(options);
  await app.runtime.session.bindExtensions({mode:'tui',uiContext:{notify(){},getEditorText:()=>'',setStatus(){},onTerminalInput:()=>()=>{}}});
  await app.runtime.session.prompt('聊聊门把手。');
  for(let i=0;i<500;i++){const d=app.diagnostics.recent();if(d.some(x=>x.stage==='judge'))break;await new Promise(r=>setTimeout(r,10))}
  console.log('HOLD',JSON.stringify(app.diagnostics.recent()));
  const diags=app.diagnostics.recent();
  assert(diags.some(d=>d.stage==='judge'&&d.result==='hold'&&d.reason==='model-hold'),'hold recorded with reason');
  assert.equal(app.runtime.session.sessionManager.getBranch().filter(e=>e.type==='custom_message'&&e.details?.origin==='inner-playground').length,0,'hold sends nothing');
 }finally{await app?.runtime.dispose();await rm(root,{recursive:true,force:true})}
});
