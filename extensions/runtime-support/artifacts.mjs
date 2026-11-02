import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function saveOutput(root,text,meta={}) {
  await fs.mkdir(root,{recursive:true,mode:0o700});
  // Refuse additional storage rather than deleting outputs referenced by old sessions.
  let bytes=Buffer.byteLength(text),count=0;
  if(bytes>64*1024*1024)throw Error('Output exceeds the 64 MiB storage limit');
  const directory=await fs.opendir(root);
  for await(const item of directory){
    if(!item.isFile()||!item.name.endsWith('.txt'))continue;
    count++;bytes+=(await fs.stat(join(root,item.name))).size;
    if(count>=1000||bytes>256*1024*1024)throw Error('Saved output storage budget exhausted; original output retained');
  }
  const id=randomUUID();
  const path=join(root,id+'.txt');await fs.writeFile(path,text,{mode:0o600});
  await fs.writeFile(join(root,id+'.json'),JSON.stringify({id,path,chars:text.length,at:new Date().toISOString(),...meta}),{mode:0o600});
  return {id,path,preview:text.slice(0,2200)+'\n\n[... middle omitted; full output retained ...]\n\n'+text.slice(-3400)+`\n\nOutput ${id}: ${path}\nUse output_read with this id and find/offset/limit for selected passages.`};
}
export async function readOutput(root,{id,find,offset=1,limit=60}) {
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))throw new Error('Invalid output id');
  if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>120)throw new Error('offset >= 1; limit must be 1..120');
  const path=join(root,id+'.txt');if((await fs.stat(path)).size>64*1024*1024)throw new Error('Output too large for inline lookup; use the file path with a bounded reader');
  const stream=createReadStream(path,{encoding:'utf8'});const reader=createInterface({input:stream,crlfDelay:Infinity});
  const rows=[];let lineNumber=0,chars=0,capped=false;const needle=find?.toLowerCase();
  try{for await(const line of reader){
    lineNumber++;if(lineNumber<offset||(needle&&!line.toLowerCase().includes(needle)))continue;
    const row=`${lineNumber}: ${line}`;const room=6000-chars;
    rows.push(row.slice(0,Math.max(0,room)));chars+=Math.min(row.length,room)+1;
    if(row.length>room){capped=true;break}
    if(rows.length>=limit)break;
  }}finally{reader.close();stream.destroy()}
  return `Output ${id}; selected lines from ${offset}.\n${rows.join('\n')}${capped?'\n[preview capped at 6000 characters; narrow the selection]':''}`;
}
const textOf=m=>typeof m?.content==='string'?m.content:(m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const clip=(text,max)=>text.length<=max?text:text.slice(0,Math.floor(max/2))+'\n[TRUNCATED: consult source session]\n'+text.slice(-Math.floor(max/2));
export function buildHandoff(entries,{sessionId,sessionFile,leafId,cwd,note='',verification=[],outputs=[]}) {
  const users=entries.filter(e=>e.type==='message'&&e.message?.role==='user').slice(-8);
  const assistants=entries.filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.stopReason==='stop').slice(-2);
  const summary=[...entries].reverse().find(e=>e.type==='compaction');
  const todo=[...entries].reverse().find(e=>e.type==='custom'&&/todo/.test(e.customType??''));
  const parts=['# Task handoff',`Session: ${sessionId}\nWorkspace: ${cwd}\nGenerated: ${new Date().toISOString()}\nSource session: ${sessionFile??'in-memory; original history not saved'}\nBranch leaf: ${leafId??'unknown'}`,
  '## Scope and latest user corrections',`Bounded extract: ${users.length} of ${entries.filter(e=>e.type==='message'&&e.message?.role==='user').length} user messages. Older constraints may be omitted; consult source before acting.`,...users.map(e=>`Entry ${e.id??'unknown'}: `+clip(textOf(e.message),1000)),
  '## Existing progress / remaining-work record',todo?clip(JSON.stringify(todo.data),3500):'No structured todo snapshot found. Consult the latest answer and verify remaining work; do not infer completion.',
  '## Recent assistant reports (claims, verify against evidence)',...assistants.map(e=>clip(textOf(e.message),2000)),
  '## Prior compaction checkpoint',summary?.summary?clip(summary.summary,2500):'None',
  '## Validation evidence',...verification.slice(-6).map(r=>`${r.at} exit=${r.exitCode??'?'} ${r.command}; tree=${r.tree??'unknown'}`),
  '## Output references',...outputs.slice(-8).map(o=>`${o.id}: ${o.path}`),
  '## Explicit continuation note',note||'None. Re-read current project instructions; check current files and validation freshness before continuing.'];
  return parts.join('\n\n')+'\n';
}
