import {mkdirSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
// Metadata only: never write message text, user text or hidden reasoning.
export class Diagnostics{
 constructor(dir){this.file=join(dir,'initiative.jsonl');mkdirSync(dir,{recursive:true,mode:0o700})}
 record(stage,result,reason='',extra={}){
  const line={ts:Date.now(),stage,result,reason:String(reason??''),...extra};
  try{appendFileSync(this.file,JSON.stringify(line)+'\n',{mode:0o600})}catch{}
 }
 recent(limit=10){
  try{return readFileSync(this.file,'utf8').trim().split('\n').slice(-limit).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean)}catch{return []}
 }
}
