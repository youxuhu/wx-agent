import assert from 'node:assert/strict';
import {mkdtemp,rm,appendFile,readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {MemoryStore,consolidate,splitSource} from '../assistants/inner/memory-store.mjs';
const root=await mkdtemp(join(tmpdir(),'inner-memory-test-'));const source=(text,id='u1')=>({id,text,quote:text,timestamp:Date.now()});
try{
 let m=await new MemoryStore(root).init();const cup='杯子只允许一种材料，而且不能拆件。';const a=await m.remember(cup,source(cup),{topic:'杯子',key:'cup-constraint'});assert.equal((await m.retrieve('杯子')).length,1);assert.equal((await m.context('杯子',{initiative:true})).length,0,'private user facts do not create autonomous topics');
 const preference='一般简短，讨论设计可以详细。';await m.remember(preference,source(preference,'u2'),{kind:'preference',key:'style'});assert((await m.context('随便聊天')).some(r=>r.text===preference));
 await assert.rejects(()=>m.remember('编造的用户经历',{id:'bad',text:'没有这段话',quote:'错误引用'}),/source/);
 const newer='杯子允许两种材料，但仍不能拆件。';await m.remember(newer,source(newer,'u3'),{topic:'杯子',key:'cup-constraint'});assert(!m.list().some(r=>r.id===a.id));assert.equal(m.records.get(a.id).status,'superseded');assert((await m.retrieve('杯子'))[0].text===newer);
 await Promise.all(['事实甲','事实乙'].map((t,i)=>m.remember(t,source(t,'serial'+i))));assert(m.list().some(r=>r.text==='事实乙'));
 await appendFile(m.file,'{"partial":');m=await new MemoryStore(root).init();assert(m.list().some(r=>r.text===newer));assert.equal((await stat(m.file)).mode&0o777,0o600);
 const before=m.seq;const forgotten=await m.forget(newer);assert.equal(forgotten.removed,1);assert.equal((await m.retrieve('杯子')).length,0);await assert.rejects(()=>m.remember('迟到结果',source('迟到结果'),{revision:before}),/stale/);
 await assert.rejects(()=>m.remember(newer,{...source(newer),timestamp:m.redactionAfter-100}),/Forgotten/);
 m=await new MemoryStore(root).init();assert.equal((await m.retrieve('杯子')).length,0);const current={role:'user',content:'我还记得什么？',timestamp:Date.now()+10};assert.deepEqual(m.filterContext([{role:'user',content:cup,timestamp:1},{role:'assistant',content:cup,timestamp:2},current]),[current]);
 let calls=0;const text='我最近在研究庭院雨水收集，决定优先观察屋檐和排水方向。';const event={id:'extract1',text,timestamp:Date.now()+10};await consolidate(m,[event],async()=>{calls++;return {memories:[{sourceId:event.id,quote:'决定优先观察屋檐和排水方向',text:'庭院研究优先观察屋檐和排水方向。',kind:'decision',topic:'庭院'}]}},new AbortController().signal,{force:true});await consolidate(m,[event],async()=>{calls++;throw Error('must not repeat')},new AbortController().signal,{force:true});assert.equal(calls,1);
 const sessions=join(root,'sessions');await import('node:fs/promises').then(f=>f.mkdir(sessions));const longText='这是较长消息中的材料说明。'.repeat(200)+'末尾仍然有重要的条件。';const sessionFile=join(sessions,'owned.jsonl');await writeFile(sessionFile,JSON.stringify({type:'message',id:'long-user',message:{role:'user',content:longText,timestamp:Date.now()+100}})+'\n');const long={id:'long-user',text:longText,sessionFile,timestamp:Date.now()+100};assert(splitSource(long).length>1);await consolidate(m,[long],async()=>({memories:[]}),new AbortController().signal,{force:true});const pending=m.pendingFragments;const recovered=await new MemoryStore(root).init();assert.equal(recovered.pendingFragments,pending);if(pending)assert(recovered.recoverLongSources().length>0);
 const late={id:'late-user',text:'一个旧请求不应在遗忘之后重新写入。',timestamp:Date.now()+200};await assert.rejects(()=>consolidate(m,[late],async()=>{await m.forget('不存在的项目');return {memories:[]}},new AbortController().signal,{force:true}),/superseded/);
 const disk=await readFile(m.file,'utf8');await writeFile(m.file,disk.replace('庭院研究','捏造研究'));assert.throws(()=>new MemoryStore(root),/corrupt/);
 console.log('PASS: Chinese recall, bounded core, source validation, versions, serialized durable journal, partial tail recovery, privacy barrier, late extraction denial, incremental consolidation and corruption rejection.');
}finally{await rm(root,{recursive:true,force:true})}
