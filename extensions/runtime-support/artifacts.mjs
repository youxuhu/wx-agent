import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function saveOutput(root,text,meta={}) {
  await fs.mkdir(root,{recursive:true,mode:0o700});const id=randomUUID();
  const path=join(root,id+'.txt');await fs.writeFile(path,text,{mode:0o600});
  await fs.writeFile(join(root,id+'.json'),JSON.stringify({id,path,chars:text.length,at:new Date().toISOString(),...meta}),{mode:0o600});
  return {id,path,preview:text.slice(0,2200)+'\n\n[... middle omitted; full output retained ...]\n\n'+text.slice(-3400)+`\n\nOutput ${id}: ${path}\nUse output_read with this id and find/offset/limit for selected passages.`};
}
export async function readOutput(root,{id,find,offset=1,limit=60}) {
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))throw new Error('Invalid output id');
  if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>120)throw new Error('offset >= 1; limit must be 1..120');
  const path=join(root,id+'.txt');if((await fs.stat(path)).size>64*1024*1024)throw new Error('Output too large for inline lookup; use the file path with a bounded reader');
  const lines=(await fs.readFile(path,'utf8')).split('\n');let rows;
  if(find){const indices=lines.map((s,i)=>s.toLowerCase().includes(find.toLowerCase())?i:-1).filter(i=>i>=0);rows=indices.filter(i=>i>=offset-1).slice(0,limit).map(i=>`${i+1}: ${lines[i]}`)}
  else rows=lines.slice(offset-1,offset-1+limit).map((s,i)=>`${offset+i}: ${s}`);
  const text=rows.join('\n');return `Output ${id}; ${lines.length} lines.\n${text.slice(0,6000)}${text.length>6000?'\n[preview capped at 6000 characters]':''}`;
}
const textOf=m=>typeof m?.content==='string'?m.content:(m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export function buildHandoff(entries,{sessionId,cwd,note='',verification=[],outputs=[]}) {
  const users=entries.filter(e=>e.type==='message'&&e.message?.role==='user').slice(-8);
  const assistants=entries.filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.stopReason==='stop').slice(-2);
  const summary=[...entries].reverse().find(e=>e.type==='compaction');
  const todo=[...entries].reverse().find(e=>e.type==='custom'&&/todo/.test(e.customType??''));
  const parts=['# Task handoff',`Session: ${sessionId}\nWorkspace: ${cwd}\nGenerated: ${new Date().toISOString()}`,
  '## Scope and latest user corrections',...users.map(e=>textOf(e.message).slice(0,1000)),
  '## Existing progress / remaining-work record',todo?JSON.stringify(todo.data).slice(0,3500):'No structured todo snapshot found. Consult the latest answer and verify remaining work; do not infer completion.',
  '## Recent assistant reports (claims, verify against evidence)',...assistants.map(e=>textOf(e.message).slice(-2000)),
  '## Prior compaction checkpoint',summary?.summary?.slice(0,2500)??'None',
  '## Validation evidence',...verification.slice(-6).map(r=>`${r.at} exit=${r.exitCode??'?'} ${r.command}; tree=${r.tree??'unknown'}`),
  '## Output references',...outputs.slice(-8).map(o=>`${o.id}: ${o.path}`),
  '## Explicit continuation note',note||'None. Re-read current project instructions; check current files and validation freshness before continuing.'];
  return parts.join('\n\n')+'\n';
}
