import * as fs from 'node:fs';
import {join,dirname,resolve,isAbsolute,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isUtf8} from 'node:buffer';
export const hash=text=>createHash('sha256').update(text).digest('hex');
export const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export class Playground {
 constructor(dir,{maxFileBytes=16384,maxBytes=524288,maxFiles=128}={}){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});this.root=fs.realpathSync(dir);this.limits={maxFileBytes,maxBytes,maxFiles};
 }
 path(name,create=false){
  if(typeof name!=='string'||!name||name.length>180||isAbsolute(name)||name.includes('\\')||name.includes('\0'))throw Error('只允许活动目录内的相对文字文件路径。');
  const parts=name.split('/');
  if(parts.length>4||parts.some(p=>!p||p.startsWith('.')||!/^[-_ .\p{L}\p{N}]+$/u.test(p))||!['.md','.txt','.json'].includes(extname(name)))throw Error('只允许 .md/.txt/.json 文字文件，最多三层子目录。');
  let current=this.root;
  for(const part of parts.slice(0,-1)){
   current=join(current,part);
   if(!fs.existsSync(current)){if(!create)throw Error('文件目录不存在。');fs.mkdirSync(current,{mode:0o700})}
   const info=fs.lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory())throw Error('禁止软链接和目录越界。');
   if(!fs.realpathSync(current).startsWith(this.root+'/'))throw Error('目录越界。');
  }
  const file=resolve(current,parts.at(-1));
  try{const info=fs.lstatSync(file);if(info.isSymbolicLink()||!info.isFile())throw Error('只允许普通文件，禁止软链接。')}catch(e){if(e.code!=='ENOENT')throw e}
  return file;
 }
 list(){
  const result=[];let bytes=0;
  const walk=(dir,prefix='',depth=0)=>{
   for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    if(item.name.startsWith('.'))continue;
    const path=prefix+item.name,full=join(dir,item.name);
    if(item.isSymbolicLink()){result.push({path,blocked:true});continue}
    if(item.isDirectory()){if(depth>=3)throw Error('活动目录层级超限。');walk(full,path+'/',depth+1);continue}
    const size=fs.lstatSync(full).size;bytes+=size;result.push({path,size,readable:['.md','.txt','.json'].includes(extname(path))});
    if(result.length>this.limits.maxFiles||bytes>this.limits.maxBytes)throw Error('活动目录空间配额已用完。');
   }
  };walk(this.root);return {files:result,bytes};
 }
 full(name){
  const file=this.path(name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const info=fs.fstatSync(fd);if(!info.isFile()||info.size>this.limits.maxFileBytes)throw Error('文件超出文字读取上限。');const buf=Buffer.alloc(this.limits.maxFileBytes+1),n=fs.readSync(fd,buf,0,buf.length,0);if(n>this.limits.maxFileBytes||!isUtf8(buf.subarray(0,n)))throw Error('不是受支持的 UTF-8 小文件。');const text=buf.subarray(0,n).toString();if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw Error('文字包含控制字符。');return text}finally{fs.closeSync(fd)}
 }
 read(name,offset=0,limit=800){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1200)throw Error('无效的读取范围。');
  const text=this.full(name);return {path:name,text:text.slice(offset,offset+limit),offset,totalCharacters:text.length,truncated:offset+limit<text.length,hash:hash(text)};
 }
 write(name,text,{append=false}={}){
  if(typeof text!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw Error('只允许普通文字。');
  const file=this.path(name,true);let before='';try{before=this.full(name)}catch(e){if(e.code!=='ENOENT')throw e}
  const after=append?before+text:text,n=Buffer.byteLength(after);
  if(n>this.limits.maxFileBytes)throw Error('单个文字文件太大。');
  const listing=this.list();if(listing.bytes-Buffer.byteLength(before)+n>this.limits.maxBytes||(!fs.existsSync(file)&&listing.files.length>=this.limits.maxFiles))throw Error('活动目录空间配额已用完。');
  const changed=before!==after;
  if(changed){const temp=join(dirname(file),'.inner-'+randomUUID());try{fs.writeFileSync(temp,after,{flag:'wx',mode:0o600});fs.renameSync(temp,file)}finally{try{fs.unlinkSync(temp)}catch{}}}
  return {path:name,changed,beforeHash:hash(before),afterHash:hash(after),before:before.slice(-300),after:after.slice(-600),bytes:n};
 }
 seed(){if(!fs.existsSync(join(this.root,'ideas.md')))this.write('ideas.md','# 可玩的想法\n\n- 没有把手的杯子：握持和隔热怎样兼顾？可以写方案、加限制、做比较。\n- 写一个从门把手视角观察房间的小故事。\n- 设计一个只有一条规则的文字小游戏。\n\n这些是起点，不是待完成清单。可以选自己觉得值得研究的方向，也可以在没有进展时休息。\n')}
}
