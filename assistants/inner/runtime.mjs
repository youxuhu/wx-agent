import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import * as fs from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createCaller} from '../../extensions/inner-loop/caller.mjs';
import {observeTerminalAttention,isTerminalRelease} from '../../extensions/inner-loop/attention.mjs';
import {Playground} from './playground.mjs';
import {PlayLoop} from './play-loop.mjs';
import {lockProfile} from './profile-lock.mjs';
import {persona} from './persona.mjs';
export const codingAgentDir=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const defaultProfile=join(homedir(),'.pi','assistants','inner');
export async function loadPi(){
 let core=process.env.PI_CORE_DIR;
 if(!core){try{core=dirname(dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent')))}catch{core=join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent')}}
 const req=createRequire(join(core,'package.json'));
 const sdk=await import(pathToFileURL(join(core,'dist/index.js')).href),{Text}=await import(pathToFileURL(join(core,'node_modules/@earendil-works/pi-tui/dist/index.js')).href),{Type}=await import(pathToFileURL(req.resolve('typebox')).href);
 return {sdk,Text,Type,core};
}
export async function createAssistant(options={}){
 const {sdk,Text,Type}=options.pi??await loadPi(),profile=resolve(options.profileDir??defaultProfile);
 if(profile===codingAgentDir)throw Error('Assistant profile must be separate from pi-config.');
 await mkdir(profile,{recursive:true,mode:0o700});const release=await lockProfile(profile);
 try{
 const workspace=join(profile,'workspace'),sessions=join(profile,'sessions');await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(sessions,{recursive:true,mode:0o700});const cwd=await realpath(workspace);
 await writeFile(join(profile,'settings.json'),JSON.stringify({defaultProvider:'deepseek',defaultModel:'deepseek-flash',quietStartup:true,retry:{enabled:false},cacheWarming:'off'},null,2)+'\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e});
 const space=new Playground(join(profile,'playground'),options.spaceLimits);space.seed();
 const mainRuntime=options.modelRuntime??await sdk.ModelRuntime.create({authPath:process.env.PI_CHAT_AUTH_PATH??join(codingAgentDir,'auth.json'),modelsPath:join(profile,'models.json'),modelsStorePath:join(profile,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
 const stream=mainRuntime.streamSimple.bind(mainRuntime);mainRuntime.streamSimple=(model,context,o={})=>stream(model,context,{...o,maxTokens:Math.min(o.maxTokens??512,512),maxRetries:0});
 let explorationRuntime,latestLoop,hostManager;
 const call=options.innerCall??createCaller(()=>explorationRuntime??=sdk.ModelRuntime.create({authPath:process.env.PI_CHAT_AUTH_PATH??join(codingAgentDir,'auth.json'),allowModelNetwork:false,refreshOnCreate:false}),codingAgentDir);
 const toolNames=['play_list','play_read','play_write'];
 const factory=pi=>{
  let closed=false,attention,unsubscribe,armed=null,pending=null;
  const canAct=ctx=>!closed&&ctx.mode==='tui'&&ctx.hasUI===true&&attention?.focused!==false&&ctx.isIdle()&&!ctx.hasPendingMessages()&&ctx.ui.getEditorText()==='';
  const status=(ctx,text)=>{if(!closed)ctx.ui.setStatus?.('inner',text)};
  const loop=new PlayLoop({space,call,stateDir:profile,canAct,status,deliver:(ctx,item)=>{
   if(!canAct(ctx))return false;
   const manager=ctx.sessionManager,file=manager.getSessionFile();
   if(!file||fs.realpathSync(dirname(file))!==fs.realpathSync(sessions)||manager.getHeader().cwd!==cwd)return false;
   const offset=fs.existsSync(file)?fs.statSync(file).size:0;
   pi.sendMessage({customType:'inner-initiative',content:item.text,display:true,details:{origin:'inner-playground',deliveryId:item.id}},{triggerTurn:false});
   const entries=manager.getEntries();
   if((!fs.existsSync(file)||fs.statSync(file).size===offset)&&!entries.some(e=>e.type==='message'&&e.message.role==='assistant')){
    if(!entries.some(e=>e.type==='custom_message'&&e.details?.deliveryId===item.id))return false;
    const temp=file+'.inner.tmp';fs.writeFileSync(temp,[manager.getHeader(),...entries].map(e=>JSON.stringify(e)).join('\n')+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);
    if(hostManager?.getSessionFile()!==file)throw Error('Session ownership changed.');hostManager.setSessionFile(file);
   }
   const size=fs.statSync(file).size-offset;if(size<=0||size>65536)return false;
   const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(size);fs.readSync(fd,b,0,size,offset);return b.toString().trim().split('\n').some(line=>{try{return JSON.parse(line).details?.deliveryId===item.id}catch{return false}})}finally{fs.closeSync(fd)}
  }});latestLoop=loop;
  const tool=(name,description,parameters,fn)=>pi.registerTool({name,label:name,description,parameters,async execute(_id,params,signal){if(signal?.aborted)throw Error('Cancelled');const result=fn(params);return {content:[{type:'text',text:JSON.stringify(result)}],details:{}}}});
  tool('play_list','列出我自己的活动目录内的文件。',Type.Object({}),()=>space.list());
  tool('play_read','只读取活动目录内的小文字文件。offset/limit 按字符计，长文件明确截断。',Type.Object({path:Type.String(),offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:1200}))}),p=>space.read(p.path,p.offset,p.limit));
  tool('play_write','只写入活动目录内 .md/.txt/.json；append 可追加。不能执行脚本或越界。',Type.Object({path:Type.String(),text:Type.String(),append:Type.Optional(Type.Boolean())}),p=>space.write(p.path,p.text,{append:p.append===true}));
  pi.registerCommand('stop',{description:'停止当前自主活动，聊天仍可继续',handler:async(_args,ctx)=>{loop.interrupt('user-stop');pending=null;status(ctx,'已停下当前活动')}});
  pi.registerCommand('about',{description:'查看这个聊天 demo 的活动空间',handler:async(_args,ctx)=>ctx.ui.notify(`Inner · 聊天与自主活动\n活动目录：${space.root}\n只在这里读写文字；无 Shell、外部文件或联网工具。直接聊天，/stop 停下当前活动，/quit 退出。`,'info')});
  pi.on('session_start',(_event,ctx)=>{
   closed=false;attention?.dispose();unsubscribe?.();
   if(ctx.mode==='tui'){
    attention=observeTerminalAttention(()=>{loop.interrupt('attention');pending=null;status(ctx,'已让路，保留完成的作品')});
    unsubscribe=ctx.ui.onTerminalInput?.(data=>{if(data!=='\x1b[I'&&!isTerminalRelease(data)&&loop.work){loop.interrupt('typing');pending=null;status(ctx,'正在听你说')}return undefined});
   }
   ctx.ui.setTitle?.('Inner · 聊天');ctx.ui.setHeader?.((_tui,theme)=>new Text(theme.fg('accent','Inner · 聊天与自主活动')+'\n直接聊天 · 自己写写想想 · /stop 停下 · /quit 退出',0,0));
   if(options.autoStart!==false)loop.start(ctx);
  });
  pi.on('session_shutdown',()=>{closed=true;loop.interrupt('shutdown');attention?.dispose();unsubscribe?.();return loop.wait()});
  pi.on('session_tree',(_event,ctx)=>{loop.interrupt('tree');pending=null;status(ctx,'已切换对话位置，旧草稿作废')});
  pi.on('input',(event,ctx)=>{loop.interrupt('input');pending=null;armed=ctx.mode==='tui'&&event.source==='interactive'?event.text:null;if(armed!==null)attention?.noteInteraction()});
  pi.on('before_agent_start',(event)=>{
   const selected=armed;armed=null;loop.interrupt('main-turn');pending=null;
   if(event.messageType==='user'&&event.prompt===selected&&selected.length<=400&&Buffer.byteLength(selected)<=900&&!/^(嗯+|哦+|好的?|谢谢|收到|ok)[。！.!\s]*$/iu.test(selected.trim()))pending={text:selected,epoch:loop.epoch};
   pi.setActiveTools(toolNames);return {systemPrompt:persona};
  });
  pi.on('message_end',event=>{if(event.message.role==='assistant'&&(['error','aborted'].includes(event.message.stopReason)||event.message.errorMessage))pending=null});
  pi.on('agent_settled',(event,ctx)=>{const task=pending;pending=null;if(!event.aborted&&task?.epoch===loop.epoch)loop.start(ctx,task.text)});
  pi.on('tool_call',event=>toolNames.includes(event.toolName)?undefined:{block:true,reason:'只开放自己的活动目录。'});
  pi.on('user_bash',()=>({result:{output:'这个聊天 demo 不执行 Shell。',exitCode:1,cancelled:false,truncated:false}}));
 };
 const createRuntime=async({sessionManager,sessionStartEvent})=>{
  hostManager=sessionManager;
  const settingsManager=sdk.SettingsManager.create(cwd,profile,{projectTrusted:false});
  const services=await sdk.createAgentSessionServices({cwd,agentDir:profile,settingsManager,modelRuntime:mainRuntime,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,noThemes:true,extensionFactories:[factory],systemPromptOverride:()=>persona,appendSystemPromptOverride:()=>[],agentsFilesOverride:()=>({agentsFiles:[]})}});
  const configured=JSON.parse(await readFile(join(profile,'settings.json'),'utf8'));
  const provider=options.provider??configured.defaultProvider??'deepseek',modelId=options.model??configured.defaultModel??'deepseek-flash',model=mainRuntime.getModel(provider,modelId);if(!model)throw Error(`Assistant model unavailable: ${provider}/${modelId}`);
  return {...await sdk.createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model,thinkingLevel:'off',tools:toolNames}),services,diagnostics:services.diagnostics};
 };
 const manager=options.fresh?sdk.SessionManager.create(cwd,sessions):sdk.SessionManager.continueRecent(cwd,sessions),runtime=await sdk.createAgentSessionRuntime(createRuntime,{cwd,agentDir:profile,sessionManager:manager});
 const dispose=runtime.dispose.bind(runtime);runtime.dispose=async()=>{try{await dispose()}finally{release()}};
 return {runtime,space,profile,cwd,sdk,get loop(){return latestLoop}};
 }catch(error){release();throw error}
}
