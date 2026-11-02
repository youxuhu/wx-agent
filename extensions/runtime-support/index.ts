/** On-demand diagnostics and evidence ledger. No system-prompt additions. */
import { join } from 'node:path';
import {Type} from 'typebox';
import {saveOutput,readOutput,buildHandoff} from './artifacts.mjs';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';
import {capture,git,locked,readState,writeState} from '../checkpoint/engine.mjs';
const ROOT=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent');
export default function runtimeSupport(pi:ExtensionAPI){
  const pending=new Map<string,string>();
  const outputRoot=join(ROOT,'outputs');
  pi.on('tool_call',(e)=>{
    if(e.toolName==='lsp_diagnostics'){
      const p=e.input as any;
      if(!Array.isArray(p.paths)||!p.paths.length||!Number.isInteger(p.limit)||p.limit<1||p.limit>5)
        return {block:true,reason:'Use explicit relevant paths and limit=1..5 for on-demand diagnostics.'};
    }
  });
  pi.on('tool_result',async(e,ctx)=>{
    if(!['bash','read','read_xlsx'].includes(e.toolName)||e.content.some(b=>b.type!=='text'))return;
    const structured=e.structuredContent as any;
    const shown=e.content.map((b:any)=>b.text??'').join('\n');
    const full=typeof structured?.output==='string'&&structured.output.length>shown.length?structured.output:shown;
    if(full.length<=8000)return;
    try{
      const saved=await saveOutput(outputRoot,full,{tool:e.toolName,sessionId:ctx.sessionManager.getSessionId(),isError:e.isError});
      return {content:[{type:'text',text:saved.preview}],...(structured&&typeof structured.output==='string'?{structuredContent:{...structured,output:saved.preview,truncated:true,full_output_path:saved.path}}:{})};
    }catch(error){ctx.ui.notify(`Output storage failed; original output retained: ${String(error)}`,'warning')}
  });
  pi.registerTool({name:'output_read',label:'Read saved output',exposure:'codemode',namespace:{name:'outputs',description:'Bounded lookup of full saved tool output'},
    description:'Read selected lines or matching passages from saved output by id.',annotations:{readOnlyHint:true},
    parameters:Type.Object({id:Type.String(),find:Type.Optional(Type.String()),offset:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:120}))}),
    async execute(_id,params){return {content:[{type:'text',text:await readOutput(outputRoot,params)}],details:{}}}
  });
  pi.registerCommand('handoff',{description:'Save a bounded task handoff from the current branch, optionally with an explicit continuation note',handler:async(note,ctx)=>{
    if(!ctx.isIdle()){ctx.ui.notify('Wait for the current run before creating a handoff.','warning');return}
    const outputs=await recentOutputs(ctx.sessionManager.getSessionId());const evidence=(await readState(ledger(ctx))).turns;
    const text=buildHandoff(ctx.sessionManager.getBranch(),{sessionId:ctx.sessionManager.getSessionId(),cwd:ctx.cwd,note,verification:evidence,outputs});
    const dir=join(ROOT,'handoffs');await fs.mkdir(dir,{recursive:true,mode:0o700});
    const path=join(dir,`${Date.now()}-${createHash('sha256').update(ctx.sessionManager.getSessionId()).digest('hex').slice(0,10)}.md`);
    await fs.writeFile(path,text,{mode:0o600});ctx.ui.notify(`Handoff saved: ${path}\nStart a new session and read this file to continue.`,'info');
  }});
  async function recentOutputs(sessionId:string){let names:string[];try{names=await fs.readdir(outputRoot)}catch{return []}
    const rows:any[]=[];for(const name of names.filter(n=>n.endsWith('.json'))){try{const r=JSON.parse(await fs.readFile(join(outputRoot,name),'utf8'));if(r.sessionId===sessionId)rows.push(r)}catch{}}
    return rows.sort((a,b)=>a.at.localeCompare(b.at)).slice(-10);
  }
  pi.registerCommand('outputs',{description:'List full output references saved for the current session',handler:async(_args,ctx)=>{
    const rows=await recentOutputs(ctx.sessionManager.getSessionId());ctx.ui.notify(rows.map(o=>`${o.at} ${o.tool} ${o.id} (${o.chars} chars)`).join('\n')||'No saved outputs.','info');
  }});

  const ledger=(ctx:ExtensionContext)=>join(ROOT,'verification',createHash('sha256').update(ctx.sessionManager.getSessionId()).digest('hex')+'.json');
  pi.on('tool_execution_start',(e)=>{if(e.toolName==='bash'&&typeof e.args?.command==='string'&&/\b(test|pytest|lint|typecheck|tsc|build|check)\b/.test(e.args.command))pending.set(e.toolCallId,e.args.command)});
  pi.on('tool_execution_end',async(e,ctx)=>{
    const command=pending.get(e.toolCallId);pending.delete(e.toolCallId);if(!command)return;
    // Retain evidence, not a model's claim that the command passed.
    let repo,tree;try{repo=(await git(ctx.cwd,['rev-parse','--show-toplevel'])).trim();tree=(await capture(repo,join(ROOT,'checkpoint-v2'),false)).tree}catch{}
    const code=e.result?.structuredContent?.exit_code??e.result?.details?.exitCode??e.result?.details?.exit_code;
    let paths:string[]=[];try{if(repo)paths=(await git(repo,['diff','--name-only','HEAD'])).split('\n').filter(Boolean).slice(0,50)}catch{}
    const recipe=/\b(pytest|test)\b/.test(command)?'test':/\b(lint|typecheck|tsc|build|check)\b/.exec(command)?.[1]??'unknown';
    const row={paths,recipe,state:e.isError?'failed':typeof code==='number'&&code===0?'executed':'unknown',command:command.replace(/(?:sk-|Bearer\s+)\S+/g,'[redacted]').slice(0,300),at:new Date().toISOString(),exitCode:typeof code==='number'?code:null,error:e.isError,repo,tree};
    const path=ledger(ctx);await locked(path,async()=>{const s=await readState(path);s.turns.push(row);s.turns=s.turns.slice(-50);await writeState(path,s)}).catch(error=>ctx.ui.notify(`Verification evidence could not be saved: ${error.message}`,'warning'));
  });
  pi.on('session_shutdown',()=>pending.clear());
  pi.registerCommand('verification',{description:'Show recorded validation executions and whether their file snapshot is still current',handler:async(args,ctx)=>{
    if(args.trim()==='recipes'){
      const recipes:string[]=[];try{const pkg=JSON.parse(await fs.readFile(join(ctx.cwd,'package.json'),'utf8'));for(const name of Object.keys(pkg.scripts??{}))if(/^(test|lint|typecheck|check|build)(:|$)/.test(name)&&/^[a-zA-Z0-9:_-]+$/.test(name))recipes.push(`npm run ${name}`)}catch{}
      for(const [file,command] of [['pyproject.toml','python -m pytest'],['pom.xml','mvn test'],['Cargo.toml','cargo check / cargo test'],['go.mod','go test ./...']]){try{await fs.access(join(ctx.cwd,file));recipes.push(`${command} (candidate; confirm project instructions)`)}catch{}}
      ctx.ui.notify(recipes.join('\n')||'No recipe detected. Read project instructions for authoritative validation commands.','info');return;
    }
    const s=await readState(ledger(ctx));const lines=[];
    for(const row of s.turns.slice(-10)){let state='unknown';if(row.repo&&row.tree){try{state=(await capture(row.repo,join(ROOT,'checkpoint-v2'),false)).tree===row.tree?'current':'stale'}catch{}}
      lines.push(`${row.at} exit=${row.exitCode??'?'} ${state} ${row.command}`)}
    ctx.ui.notify(lines.join('\n')||'No validation executions recorded.','info');
  }});
  pi.registerCommand('effective-config',{description:'Show resolved runtime model, tools, compaction and watchdog settings',handler:async(_args,ctx)=>{
    const s=pi.getSettings();const key=ctx.model?`${ctx.model.provider}/${ctx.model.id}`:'?';const c=s.compaction;const reserve=c?.modelOverrides?.[key]?.reserveTokens??c?.reserveTokens??16384;const w=ctx.model?.contextWindow;
    ctx.ui.notify(JSON.stringify({model:key,thinking:pi.getThinkingLevel(),contextWindow:w,compaction:{enabled:c?.enabled!==false,reserveTokens:reserve,threshold:w?w-reserve:null,keepRecentTokens:c?.modelOverrides?.[key]?.keepRecentTokens??c?.keepRecentTokens??20000},watchdog:s.subagents?.watchdog??{},activeTools:pi.getActiveTools()},null,2),'info');
  }});
  pi.registerCommand('updates',{description:'Show cached candidate versions; /updates check refreshes metadata without installing',handler:async(args,ctx)=>{
    if(args.trim()==='check'){
      const result=await pi.exec('python3',[join(ROOT,'scripts/maintain.py'),'update-check','--root',ROOT],{timeout:30000});
      if(result.code!==0){ctx.ui.notify('Update metadata check failed; nothing installed.','warning');return}
    }
    try{const r=JSON.parse(await fs.readFile(join(ROOT,'maintenance-candidates.json'),'utf8'));ctx.ui.notify(`Checked: ${r.checkedAt}\n`+r.packages.map((p:any)=>`${p.name}: ${p.installed} → ${p.available??'?'} (${p.status})`).join('\n')+'\nRead-only preview. Candidates have not passed compatibility tests.','info')}catch{ctx.ui.notify('No candidate metadata. Use /updates check for an explicit read-only registry lookup.','info')}
  }});
  pi.registerCommand('health',{description:'Check installed plugins, watchdog bridge, snapshot state and configuration sources without model requests',handler:async(_args,ctx)=>{
    const lines=[];
    const settings=pi.getSettings();
    const packages=(settings.packages??[]).filter((v:any)=>typeof v==='string'&&v.startsWith('npm:')) as string[];
    for(const spec of packages){const raw=spec.slice(4), cut=raw.lastIndexOf('@');const name=cut>0?raw.slice(0,cut):raw,expected=cut>0?raw.slice(cut+1):'?';
      try{const p=JSON.parse(await fs.readFile(join(ROOT,'npm/node_modules',name,'package.json'),'utf8'));lines.push(`${name}: ${p.version}${expected===p.version?' locked':' VERSION MISMATCH'}`)}catch{lines.push(`${name}: missing`)}}

    let bridge=false;const off=pi.events.on('pi-subagents:watchdog-state:v1',(e:any)=>{if(e.sessionId===ctx.sessionManager.getSessionId())bridge=true});pi.events.emit('pi-subagents:watchdog-query:v1',{});off();lines.push(`watchdog bridge: ${bridge?'ready':'unavailable (patch may need reapplying)'}`);
    for(const file of [join(ROOT,'settings.json'),join(ctx.cwd,'.pi/settings.json')]){try{await fs.access(file);lines.push(`settings source: ${file}`)}catch{}}
    try{await git(ctx.cwd,['rev-parse','--show-toplevel']);lines.push('undo: git workspace available')}catch{lines.push('undo: no git workspace; file undo unavailable')}
    try{const result=await pi.exec('python3',[join(ROOT,'scripts/maintain.py'),'verify','--root',ROOT],{timeout:10000});const report=JSON.parse(result.stdout);lines.push(`runtime lock: ${report.ok?'verified':report.issues.join('; ')}`)}catch{lines.push('runtime lock: unavailable or invalid')}
    lines.push('Details: /effective-config; evidence: /verification; recipes: /verification recipes; updates: /updates');ctx.ui.notify(lines.join('\n'),'info');
  }});
}
