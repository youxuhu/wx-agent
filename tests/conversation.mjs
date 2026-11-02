import {createJiti} from './helpers.mjs';
import {promises as fs} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import assert from 'node:assert/strict';import {git} from '../extensions/checkpoint/engine.mjs';
const root=await fs.mkdtemp(join(tmpdir(),'pi-conversation-'));process.env.PI_CODING_AGENT_DIR=join(root,'agent');
try{
const repo=join(root,'repo');await fs.mkdir(repo);await git(repo,['init','-q']);await fs.writeFile(join(repo,'file'),'initial');
const events=new Map(),commands=new Map(),entries=[];let leaf=null,n=0,editor='';
const manager={getSessionId:()=> 'test-session',getLeafId:()=>leaf,getBranch:()=>{const a=[];let e=entries.find(x=>x.id===leaf);while(e){a.unshift(e);e=entries.find(x=>x.id===e.parentId)}return a},getEntry:id=>entries.find(x=>x.id===id)};
const append=e=>{const v={id:String(++n),parentId:leaf,...e};entries.push(v);leaf=v.id;return v};
const messages=[];
const pi={on:(k,v)=>events.set(k,v),registerCommand:(k,v)=>commands.set(k,v),appendEntry:(customType,data)=>append({type:'custom',customType,data})};
const ctx={cwd:repo,sessionManager:manager,isIdle:()=>true,ui:{notify:(s,k)=>{messages.push(s);if(k==='error')throw Error(s)},setEditorText:s=>editor=s},navigateTree:async(id)=>{assert(entries.find(x=>x.id===id));leaf=id;return {cancelled:false}}};
const jiti=createJiti(import.meta.url);const {default:extension}=await jiti.import('../extensions/checkpoint/index.ts');extension(pi);
async function turn(prompt,body){await events.get('before_agent_start')({messageType:'user',prompt},ctx);append({type:'message',message:{role:'user',content:prompt}});await fs.writeFile(join(repo,'file'),body);append({type:'message',message:{role:'assistant',content:'done'}});await events.get('agent_settled')({},ctx)}
await turn('first','one');await turn('second','two');
await commands.get('undo').handler('',ctx);assert.equal(await fs.readFile(join(repo,'file'),'utf8'),'one');assert.equal(editor,'second');assert.equal(manager.getBranch().filter(e=>e.message?.role==='user').length,1);
await commands.get('undo').handler('',ctx);assert.equal(await fs.readFile(join(repo,'file'),'utf8'),'initial');assert.equal(manager.getBranch().filter(e=>e.message?.role==='user').length,0);
await commands.get('redo').handler('',ctx);assert.equal(await fs.readFile(join(repo,'file'),'utf8'),'one');await commands.get('redo').handler('',ctx);assert.equal(await fs.readFile(join(repo,'file'),'utf8'),'two');assert.equal(manager.getBranch().filter(e=>e.message?.role==='user').length,2);
console.log('PASS: two user turns, two undo, two redo; file + conversation + editor restored together.');
}finally{await fs.rm(root,{recursive:true,force:true})}
