import {open,readFile,unlink} from 'node:fs/promises';
import {readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function lockProfile(dir){
 const file=join(dir,'assistant.lock'),token=randomUUID();let handle;
 try{handle=await open(file,'wx',0o600)}catch(error){
  if(error.code!=='EEXIST')throw error;
  const before=await readFile(file,'utf8'),owner=JSON.parse(before);let dead=false;
  if(Number.isSafeInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0)}catch(e){dead=e.code==='ESRCH'}}
  if(!dead)throw Error('这个助手 profile 已被另一个进程使用。请关闭它，或用 --profile 选择独立目录。');
  if(await readFile(file,'utf8')!==before)throw Error('Profile ownership changed.');
  await unlink(file);handle=await open(file,'wx',0o600);
 }
 await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();
 const release=()=>{try{if(JSON.parse(readFileSync(file,'utf8')).token===token)unlinkSync(file)}catch{}};
 process.once('exit',release);
 return ()=>{process.removeListener('exit',release);release()};
}
