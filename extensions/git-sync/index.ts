/** Nonblocking config sync. Git pre-push enforces scanning on every push path. */
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {homedir} from 'node:os';import {join} from 'node:path';
import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';
const run=promisify(execFile);const root=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent');
async function git(args:string[]){return (await run('git',['-C',root,...args],{timeout:12000,maxBuffer:2*1024*1024,env:{...process.env,GIT_AUTO_PUSH:"0"}})).stdout.trim()}
export default function sync(pi:ExtensionAPI){let busy=false;let alive=true;
 async function cycle(ctx:ExtensionContext,manual=false){if(busy)return;busy=true;try{
  await git(['remote','get-url','origin']);await git(['fetch','origin']);
  const branch=await git(['symbolic-ref','--quiet','--short','HEAD']);
  if(manual&&(await git(['status','--porcelain']))){await git(['add','-A']);await git(['commit','-m',`sync: agent configuration ${new Date().toISOString()}`])}
  const [ahead,behind]=(await git(['rev-list','--left-right','--count',`HEAD...origin/${branch}`])).split(/\s+/).map(Number);
  if(ahead)await git(['push','origin',branch]);
  if(behind&&alive&&ctx.hasUI){if(await ctx.ui.confirm('Sync pi config?',`Remote has ${behind} new commits. Pull with ff-only?`)){if(await git(['status','--porcelain']))throw new Error('Working tree is modified; commit before pulling');await git(['pull','--ff-only','origin',branch]);ctx.ui.notify('Config updated. Run /reload to apply.','info')}}
  if(manual&&alive)ctx.ui.notify('Config sync completed.','info');
 }catch(e){if(manual&&alive)ctx.ui.notify(`Config sync failed: ${e instanceof Error?e.message:String(e)}`,'warning')}finally{busy=false}}
 pi.on('session_start',(_e,ctx)=>{alive=true;void cycle(ctx)});
 pi.on('session_shutdown',()=>{alive=false});
 pi.registerCommand('git-sync',{description:'Fetch, commit local config, push through secret checks, and offer ff-only pull',handler:(_args,ctx)=>cycle(ctx,true)});
}
