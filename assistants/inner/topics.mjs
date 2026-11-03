import * as fs from 'node:fs';
import {join} from 'node:path';
import {hash,normalize} from './playground.mjs';
const allowedSources=new Set(['interest','open-question','artifact','knowledge','preference','web']);
const allowedStates=new Set(['seed','ready','spoken','dormant']);

export class TopicLedger{
 constructor(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  this.file=join(dir,'topics.json');
  this.state={version:1,topics:[],meta:{turn:0,newTopics:0,lastTurnId:null,lastNewTopicTurn:-999,held:{}}};
  if(fs.existsSync(this.file)){
   const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(saved.version!==1||!Array.isArray(saved.topics))throw Error('Invalid topic ledger');
   this.state={...this.state,...saved,meta:{...this.state.meta,...(saved.meta??{})}};
   for(const t of this.state.topics)if(!t.id||!allowedSources.has(t.source)||!allowedStates.has(t.state)||typeof t.title!=='string')throw Error('Invalid topic record');
  }
 }
 save(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state,null,2)+'\n',{mode:0o600});fs.renameSync(temp,this.file)}
 startSession(){this.state.meta.newTopics=0;this.state.meta.lastNewTopicTurn=-999;this.save()}
 turn(turnId){if(turnId&&turnId!==this.state.meta.lastTurnId){this.state.meta.turn++;this.state.meta.lastTurnId=turnId;this.save()}}
 add({title,source,basis,topicId=null}){
  if(typeof title!=='string'||!title.trim()||title.length>120||!allowedSources.has(source)||!Array.isArray(basis)||!basis.length||basis.some(b=>typeof b!=='string'||!b))return null;
  const norm=normalize(title);
  const existing=this.state.topics.find(t=>t.id===topicId||normalize(t.title)===norm);
  if(existing){if(existing.state==='dormant')existing.state='seed';this.save();return existing}
  const id=topicId??'t-'+hash(norm).slice(0,10);
  const topic={id,title:title.trim(),source,basis:[...new Set(basis)].slice(0,6),state:'seed',createdAt:Date.now(),lastSpokenAt:null,attempts:0,lastHeldAt:null};
  this.state.topics.push(topic);this.state.topics=this.state.topics.slice(-80);this.save();return topic;
 }
 seedFromMemory(records){
  let changed=false;
  for(const r of records??[]){
   if(!['open-question','artifact','knowledge','preference'].includes(r.kind)||typeof r.text!=='string'||!r.text.trim())continue;
   if(this.state.topics.some(t=>t.basis.includes('mem:'+r.id)))continue;
   const before=this.state.topics.length;
   this.add({title:r.text.slice(0,80),source:r.kind==='open-question'?'open-question':r.kind==='artifact'?'artifact':r.kind==='preference'?'preference':'knowledge',basis:['mem:'+r.id],topicId:'mem:'+r.id});
   if(this.state.topics.length!==before)changed=true;
  }
  return changed;
 }
 pick({allowSpoken=false}={}){
  return this.state.topics.filter(t=>t.state==='seed'||t.state==='ready'||(allowSpoken&&t.state==='spoken')).slice(0,8);
 }
 markSpoken(id){const t=this.state.topics.find(x=>x.id===id);if(t){t.state='spoken';t.lastSpokenAt=Date.now()}this.state.meta.newTopics++;this.state.meta.lastNewTopicTurn=this.state.meta.turn;this.save()}
 markHeld(id,reason){const t=this.state.topics.find(x=>x.id===id);if(t){t.attempts++;t.lastHeldAt=Date.now();if(t.attempts>=2)t.state='dormant'}this.state.meta.held[id]=String(reason??'').slice(0,60);this.save()}
 canNewTopic({everyTurns=3,maxPerSession=2,startup=false}={}){
  if(this.state.meta.newTopics>=maxPerSession)return false;
  if(startup)return true;
  return this.state.meta.turn-this.state.meta.lastNewTopicTurn>=everyTurns;
 }
}
