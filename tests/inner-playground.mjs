import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Playground} from '../assistants/inner/playground.mjs';
import {PlayLoop,actSystem,validStep,validReview} from '../assistants/inner/play-loop.mjs';
const root=await mkdtemp(join(tmpdir(),'inner-play-tests-'));
const plan=(action,path,text,question,message,next)=>({action,path,text,question,expected:'获得具体可检查的变化',message,next});
const review=(kind,share=false,cont=true)=>({progress:kind!=='none',kind,summary:kind==='none'?'只是重复原有内容':'新约束或作品带来了可见区别',share,reason:'合成测试判断，不是人类偏好',continue:cont});
try{
 const space=new Playground(join(root,'playground'));space.seed();
 assert.throws(()=>space.read('../private.txt'));assert.throws(()=>space.write('/tmp/escape.md','bad'));assert.throws(()=>space.write('x.js','bad'));assert.throws(()=>space.write('x.md','\x1b[31m'));
 await symlink(join(root,'private.txt'),join(space.root,'link.md'));assert.throws(()=>space.read('link.md'));assert.throws(()=>space.write('link.md','bad'));
 await mkdir(join(root,'outside'));await symlink(join(root,'outside'),join(space.root,'escape'));assert.throws(()=>space.write('escape/x.md','bad'));
 space.write('notes/range.md','a'.repeat(1000));assert.equal(space.read('notes/range.md',800,100).text.length,100);assert.equal(space.read('notes/range.md',0,100).truncated,true);assert.equal((await stat(join(space.root,'notes/range.md'))).mode&0o777,0o600);
 const tiny=new Playground(join(root,'tiny'),{maxBytes:100});tiny.write('a.md','x'.repeat(80));assert.throws(()=>tiny.write('b.md','x'.repeat(30)));
 const steps=[
  plan('read','ideas.md',null,'选一个值得玩的方向',null,'写无把手杯子方案'),
  plan('write','drafts/cup.md','方案一：分别考虑握持与隔热。','拆开杯子的两个设计问题','我在试着拆开无把手杯子的握持和隔热问题。','加入一种材料的限制'),
  plan('append','drafts/cup.md','\n新限制：只能用一种材料，比较形状与壁厚。','考虑单材料约束',null,'写出两种方案的取舍'),
  plan('write','drafts/comparison.md','方案A改变形状，方案B改变壁厚；两者都还需要实际测试。','比较两种取舍','加上“只能一种材料”的限制后，改变形状和改变壁厚似乎值得分别试试。','写一段小故事'),
  plan('write','drafts/story.md','门把手每天听见房间里不同的声音，今天它决定只记住一次轻轻的敲门。','发展一个具体故事片段','我还写了个从门把手视角开始的小片段。',null)
 ];
 let i=0,active=true;const sent=[];
 const loop=new PlayLoop({space,call:async system=>system===actSystem?steps[i]:review(['information','creation','constraint','comparison','creation'][i],!!steps[i++].message,i<5),stateDir:root,deliver:(_ctx,m)=>{sent.push(m);return true},canAct:()=>active,status(){}});
 await loop.start({});assert.equal(loop.state.steps,5);assert.equal(sent.length,3);assert.equal(loop.state.reason,'complete');assert((await readFile(join(space.root,'drafts/comparison.md'),'utf8')).includes('实际测试'));assert.equal(loop.state.messages,3);assert.equal(loop.state.observations.length,3);const reopened=new PlayLoop({space,call:async()=>{throw Error('not run')},stateDir:root,deliver(){},canAct:()=>true,status(){}});assert.deepEqual(reopened.state.observations,JSON.parse(JSON.stringify(loop.state.observations)),'actual observations survive restart');
 const before=loop.state.steps;await new Promise(r=>setTimeout(r,30));assert.equal(loop.state.steps,before,'idle time never triggers another model call');
 const repeatDir=join(root,'repeat');await mkdir(repeatDir);const repeatSpace=new Playground(join(repeatDir,'play'));repeatSpace.write('cup.md','握持和隔热需要分别考虑。');
 let calls=0;const noProgress=new PlayLoop({space:repeatSpace,stateDir:repeatDir,call:async system=>{calls++;return system===actSystem?plan('write','cup.md','需要分别考虑隔热问题与握持问题。','改写原来的说法','又有新发现了','继续改写'):review('none',false,false)},canAct:()=>true,status(){},deliver(){throw Error('Paraphrase must not speak')}});
 await noProgress.start({});assert.equal(calls,2);assert.equal(noProgress.state.reason,'no-progress');assert.equal(noProgress.state.messages,0);
 const sameDir=join(root,'same');await mkdir(sameDir);const sameSpace=new Playground(join(sameDir,'play'));sameSpace.write('cup.md','原有方案');
 let sameCalls=0;const same=new PlayLoop({space:sameSpace,stateDir:sameDir,call:async()=>{sameCalls++;return plan('write','cup.md','原有方案','重复相同文件',null,'再做一次')},canAct:()=>true,status(){},deliver(){return true}});await same.start({});assert.equal(sameCalls,1);assert.equal(same.state.reason,'no-change');
 assert(!validStep({...steps[1],action:'shell'}));assert(!validReview({...review('none',false,false),share:true}));
 const abortDir=join(root,'abort');await mkdir(abortDir);let release;const abortedSent=[];
 const aborted=new PlayLoop({space:new Playground(join(abortDir,'play')),stateDir:abortDir,call:async()=>new Promise(r=>{release=r}),canAct:()=>active,status(){},deliver:(_ctx,m)=>{abortedSent.push(m);return true}});
 const work=aborted.start({});await new Promise(r=>setTimeout(r,0));aborted.interrupt('typing');release(steps[1]);await work;assert.equal(abortedSent.length,0);assert.equal(aborted.space.list().files.length,0);
 console.log('PASS: playground bounds/symlinks/quotas; five progressive actions and three messages; paraphrase/no-change/idle stop; cancellation rejects late file writes and messages.');
}finally{await rm(root,{recursive:true,force:true})}
