/** User-prompt undo/redo: files and conversation move together. No model prompt injection. */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { git, capture, restore, locked, readState, writeState } from './engine.mjs';
const ROOT=join(process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'),'checkpoint-v2');
export default function checkpoint(pi:ExtensionAPI){
  let active:any; let serial=Promise.resolve();
  const queue=(f:()=>Promise<void>)=>{const p=serial.then(f);serial=p.catch(()=>{});return p};
  const location=(ctx:ExtensionContext)=>join(ROOT,createHash('sha256').update(ctx.sessionManager.getSessionId()).digest('hex')+'.json');
  const report=(ctx:ExtensionContext,e:unknown)=>ctx.ui.notify(`Checkpoint: ${e instanceof Error?e.message:String(e)}`,'error');
  pi.on('before_agent_start',async(event,ctx)=>{
    if(event.messageType!=='user')return;
    await queue(async()=>{
      active=undefined;
      try{
        const repo=(await git(ctx.cwd,['rev-parse','--show-toplevel'])).trim();
        const snapshot=await capture(repo,ROOT);
        pi.appendEntry('undo-boundary',{version:2});
        const entryId=ctx.sessionManager.getLeafId();
        const turn={id:randomUUID(),repo,before:snapshot.tree,beforeRef:snapshot.ref,entryId,prompt:event.prompt,at:new Date().toISOString()};
        const path=location(ctx);
        await locked(path,async()=>{const s=await readState(path);s.turns.push(turn);s.redo=[];
          const expired=s.turns.splice(0,Math.max(0,s.turns.length-50));
          await writeState(path,s);
          for(const old of expired)for(const ref of [old.beforeRef,old.afterRef])if(ref)await git(old.repo,['update-ref','-d',ref]).catch(()=>{});});
        active={...turn,path};
      }catch(e){if(!String(e).includes('not a git repository'))report(ctx,e)}
    });
  });
  // A model may use many internal tool turns and watchdog continuations for one user prompt.
  const finish=async(_:unknown,ctx:ExtensionContext)=>queue(async()=>{
    if(!active||active.path!==location(ctx))return;
    try{
      const end=await capture(active.repo,ROOT);const leaf=ctx.sessionManager.getLeafId();
      const branch=ctx.sessionManager.getBranch();const marker=branch.findIndex(e=>e.id===active.entryId);
      const user=branch.slice(marker+1).find((e:any)=>e.type==='message'&&e.message.role==='user');
      await locked(active.path,async()=>{const s=await readState(active.path);const row=s.turns.find((t:any)=>t.id===active.id);if(row){const previous=row.afterRef;Object.assign(row,{after:end.tree,afterRef:end.ref,endLeaf:leaf,userId:user?.id});await writeState(active.path,s);if(previous&&previous!==end.ref)await git(active.repo,['update-ref','-d',previous]).catch(()=>{})}});
    }catch(e){report(ctx,e)}
  });
  pi.on('agent_settled',finish);
  pi.on('session_start',(_e,_ctx)=>{active=undefined});
  pi.on('session_shutdown',async()=>{await serial;active=undefined});
  async function change(ctx:ExtensionCommandContext,redo:boolean){
    if(!ctx.isIdle()){ctx.ui.notify('Stop the current run before undo/redo.','warning');return}
    await queue(async()=>{
      const path=location(ctx);
      try{await locked(path,async()=>{
        const s=await readState(path);const branch=new Set(ctx.sessionManager.getBranch().map(e=>e.id));
        const row=redo?s.redo.at(-1):[...s.turns].reverse().find((t:any)=>t.endLeaf&&branch.has(t.userId));
        if(!row){let text=redo?'Nothing to redo.':'No complete user-turn checkpoint on this branch.';try{await git(ctx.cwd,['rev-parse','--show-toplevel'])}catch{text='Undo requires a Git workspace; files and conversation were not changed.'}ctx.ui.notify(text,'info');return}
        if(!row.after||!row.endLeaf)throw new Error('Turn did not finish recording; undo is unavailable');
        const oldLeaf=ctx.sessionManager.getLeafId();
        if(redo&&oldLeaf!==row.entryId&&ctx.sessionManager.getEntry(row.entryId)?.parentId!==oldLeaf)throw new Error('Conversation changed since undo; redo is unavailable');
        const paths=await restore(row.repo,redo?row.before:row.after,redo?row.after:row.before,ROOT);
        try{
          const result=await ctx.navigateTree(redo?row.endLeaf:row.entryId,{summarize:false});
          if(result.cancelled)throw new Error('Conversation navigation cancelled');
        }catch(error){await restore(row.repo,redo?row.after:row.before,redo?row.before:row.after,ROOT);throw error}
        if(redo)s.redo.pop();else s.redo.push(row);
        await writeState(path,s);active=undefined;
        ctx.ui.setEditorText(redo?'':row.prompt);
        ctx.ui.notify(`${redo?'Redone':'Undone'} one user turn (${paths.length} file changes).`,'info');
      })}catch(e){report(ctx,e)}
    });
  }
  pi.registerCommand('undo',{description:'Undo the last user turn: files and conversation; put its prompt back in the editor',handler:(_args,ctx)=>change(ctx,false)});
  pi.registerCommand('redo',{description:'Restore the last undone user turn and its file changes',handler:(_args,ctx)=>change(ctx,true)});
  pi.registerCommand('rewind',{description:'Alias for /undo; /rewind list shows user-turn checkpoints',handler:async(args,ctx)=>{
    if(args.trim()==='list'){try{const s=await readState(location(ctx));ctx.ui.notify(s.turns.slice(-15).reverse().map((t:any)=>`${t.at} ${t.after?'ready':'incomplete'} ${t.prompt.slice(0,60)}`).join('\n')||'No checkpoints.','info')}catch(e){report(ctx,e)}return}await change(ctx,false)
  }});
}
