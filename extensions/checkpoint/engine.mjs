import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function git(repo, args, env = {}) {
  return new Promise((ok, fail) => {
    const p = spawn('git', ['-C', repo, ...args], { env: {...process.env, ...env}, stdio: ['ignore','pipe','pipe'] });
    const chunks=[]; const errors=[]; let size=0;
    const timer=setTimeout(()=>p.kill('SIGTERM'),30000);
    p.stdout.on('data', b=>{size+=b.length;if(size>64*1024*1024)p.kill();else chunks.push(b)});
    p.stderr.on('data', b=>errors.push(b));p.on('error',e=>{clearTimeout(timer);fail(e)});
    p.on('close',(code)=>{clearTimeout(timer);code===0?ok(Buffer.concat(chunks).toString('utf8')):fail(new Error(Buffer.concat(errors).toString('utf8').slice(0,1000)||`git failed (${code})`))});
  });
}
export async function locked(path, action) {
  await fs.mkdir(dirname(path),{recursive:true});
  const lock=path+'.lock'; const deadline=Date.now()+10000;
  while(true){try{await fs.mkdir(lock);break}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>deadline)throw new Error('Checkpoint is locked by another process');await new Promise(r=>setTimeout(r,50))}}
  try{return await action()}finally{await fs.rmdir(lock)}
}
export async function readState(path){try{return JSON.parse(await fs.readFile(path,'utf8'))}catch(e){if(e.code==='ENOENT')return {version:2,turns:[],redo:[]};throw new Error('Checkpoint state is damaged; original file retained')}}
export async function writeState(path,value){await fs.mkdir(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(tmp,path)}
export async function capture(repo, store, retain = true) {
  await fs.mkdir(store,{recursive:true});const index=join(store,'index-'+randomUUID());const env={GIT_INDEX_FILE:index};
  try{
    // Private index: preserve the user's index and pre-existing uncommitted work.
    await git(repo,['read-tree',(await git(repo,['write-tree'])).trim()],env);
    await git(repo,['add','-A','--','.'],env);
    const tree=(await git(repo,['write-tree'],env)).trim();
    const ref=retain?'refs/pi-checkpoints/'+randomUUID():undefined;if(ref)await git(repo,['update-ref',ref,tree]);return {tree,ref};
  }finally{await fs.rm(index,{force:true});await fs.rm(index+'.lock',{force:true})}
}
export async function entries(repo,tree){
  const raw=await git(repo,['ls-tree','-rz',tree]);const out=new Map();
  for(const part of raw.split('\0')){if(!part)continue;const tab=part.indexOf('\t');const [mode,type,oid]=part.slice(0,tab).split(' ');out.set(part.slice(tab+1),{mode,type,oid})}return out;
}
function same(a,b){return a?.oid===b?.oid&&a?.mode===b?.mode}
export async function restore(repo, fromTree, toTree, store) {
  const [from,to]=await Promise.all([entries(repo,fromTree),entries(repo,toTree)]);
  const paths=[...new Set([...from.keys(),...to.keys()])].filter(p=>!same(from.get(p),to.get(p)));
  const current=await capture(repo,store,false);const now=await entries(repo,current.tree);
  const conflicts=paths.filter(p=>!same(now.get(p),from.get(p)));
  if(conflicts.length)throw new Error('Files changed since this turn; undo stopped: '+conflicts.slice(0,8).join(', '));
  // Preflight all paths before the first mutation; never traverse a changed symlink parent.
  for(const p of paths){const full=resolve(repo,p);const rel=relative(repo,full);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Invalid snapshot path');
    if((from.get(p)?.type??'blob')!=='blob'||(to.get(p)?.type??'blob')!=='blob')throw new Error('Submodule undo is unsupported: '+p);
    let dir=dirname(full);while(dir!==repo){try{if((await fs.lstat(dir)).isSymbolicLink())throw new Error('Symlink parent: '+p)}catch(e){if(e.code!=='ENOENT')throw e}dir=dirname(dir)}
    if(!to.has(p)){try{if((await fs.lstat(full)).isDirectory())throw new Error('Directory replaced file: '+p)}catch(e){if(e.code!=='ENOENT')throw e}}
  }
  const apply=async(source,target)=>{
    for(const p of paths){const full=join(repo,p);const value=target.get(p);
      if(!value){await fs.unlink(full).catch(e=>{if(e.code!=='ENOENT')throw e});continue}
      // restore from snapshot through Git, with no writes to the real index.
      await git(repo,['--literal-pathspecs','restore','--source',source,'--worktree','--',p]);
    }
  };
  try{await apply(toTree,to);const check=await capture(repo,store,false);const actual=await entries(repo,check.tree);if(paths.some(p=>!same(actual.get(p),to.get(p))))throw new Error('Restored content failed verification')}
  catch(error){try{await apply(fromTree,from)}catch(rollback){throw new Error(`Restore and rollback failed: ${error.message}; ${rollback.message}`)}throw error}
  return paths;
}
