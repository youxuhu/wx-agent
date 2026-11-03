import {createHash,randomUUID} from 'node:crypto';
import {existsSync,statSync,openSync,readSync,closeSync} from 'node:fs';
import {ShadowController} from './controller.mjs';
import {conversationalPrompts} from './conversation.mjs';
import {observeTerminalAttention,isTerminalRelease} from './attention.mjs';
import {generationInput} from '../../experiments/inner-loop/prompts.mjs';
import {requestInputBound} from '../../experiments/inner-loop/budget.mjs';

// Auto is explicitly enabled by the user; inference and delivery have separate final gates.
export function installTui(pi,call){
 const core=new ShadowController(call,conversationalPrompts);
 let automatic=false,autoSpeak=false,capture=false,pending=null,prepared=null,lastMaterial='',stale=false,unsubscribe,work=null,queued=null,attention,armedUser=null;
 const status=(ctx,text)=>{if(!stale)ctx.ui.setStatus?.('inner-loop',text)};
 const cancel=()=>{core.cancel();pending=null;prepared=null;queued=null;armedUser=null};
 const reset=()=>{cancel();core.reset();automatic=false;autoSpeak=false;capture=false;lastMaterial='';armedUser=null};
 const available=ctx=>ctx.mode==='tui'&&ctx.hasUI===true&&attention?.focused!==false&&ctx.isIdle()&&!ctx.hasPendingMessages()&&ctx.ui.getEditorText()==='';
 const saved=ctx=>{const file=ctx.sessionManager.getSessionFile();return file&&existsSync(file)&&ctx.sessionManager.getBranch().some(e=>e.type==='message'&&e.message.role==='assistant')?file:null};
 const deliver=(ctx,item,auto=false)=>{
  if(stale||!available(ctx)||item.epoch!==core.epoch||item.session!==ctx.sessionManager.getSessionId()||item.workspace!==ctx.cwd||(auto&&(!automatic||!autoSpeak)))return false;
  try{
  const file=saved(ctx);if(!file){status(ctx,'想法 · 等首轮普通对话保存后再自动开口');return false}
  // Consume before append. A failed/uncertain append is never automatically replayed.
  prepared=null;const offset=statSync(file).size;
  pi.sendMessage({customType:auto?'inner-loop-active':'inner-loop-approved',content:item.result.message,display:true,details:{origin:'inner-loop',deliveryId:item.id,mode:auto?'auto':'user-approved-once'}},{triggerTurn:false});
  let persisted=false;const size=statSync(file).size-offset;
  if(size>0&&size<=65536){const fd=openSync(file,'r');try{const b=Buffer.alloc(size);readSync(fd,b,0,size,offset);persisted=b.toString().trim().split('\n').some(line=>{try{const e=JSON.parse(line);return e.type==='custom_message'&&e.details?.deliveryId===item.id}catch{return false}})}finally{closeSync(fd)}}
  core.history=[...core.history,item.result.message].slice(-2);
  if(!persisted){automatic=false;autoSpeak=false;capture=false;core.mode='off'}
  status(ctx,persisted?(auto?'想法 · 自动发出一条，等待新话题':'想法 · 已保存一条，本次授权结束'):'想法 · 保存未确认，已停止且不会重发');
  return persisted;
  }catch{
   prepared=null;automatic=false;autoSpeak=false;capture=false;core.mode='off';
   status(ctx,'想法 · 保存未确认，已停止且不会重发');return false;
  }
 };
 const publishShadow=(ctx,item)=>{
  if(!available(ctx)||item.epoch!==core.epoch||item.session!==ctx.sessionManager.getSessionId())return;
  pi.sendMessage({customType:'inner-loop-shadow',content:`[Inner Loop shadow — 仅预览]\n${item.result.message}`,display:true,details:{origin:'inner-loop',mode:'shadow',delivered:false}},{triggerTurn:false});
 };
 const launch=(ctx,{event=false,review=false}={})=>{
  if(core.mode!=='shadow'||core.episode||!available(ctx)||!core.notes.length)return;
  if(event&&autoSpeak&&!saved(ctx)){status(ctx,'想法 · 等首轮普通对话保存后再自动开口');return}
  if(work){queued={ctx,event,review,epoch:core.epoch};status(ctx,'想法 · 等待上一请求停止');return}
  // Keep selected notes intact. Shorten only the already bounded reply/history snippets.
  const bound=()=>requestInputBound(conversationalPrompts.generateSystem,generationInput({interest:'Explicitly selected topics.',open:'Useful supported connection.',attention:'idle',history:core.history,notes:core.notes.map(n=>({...n,visited:false}))}));
  while(core.history.length&&bound()>2048){if(core.history[0].length>32)core.history[0]=core.history[0].slice(0,Math.floor(core.history[0].length/2));else core.history.shift()}
  const material=JSON.stringify(core.notes);if(event&&material===lastMaterial)return;if(event)lastMaterial=material;
  const epoch=core.epoch;
  work=core.run(ctx).then(result=>{
   if(stale||epoch!==core.epoch||core.result!==result)return;
   if(!result.wouldSpeak){status(ctx,'想法 · 暂时没有新补充');return}
   prepared={id:randomUUID(),epoch,session:ctx.sessionManager.getSessionId(),workspace:ctx.cwd,result};
   if(event&&autoSpeak&&!review){deliver(ctx,prepared,true);return}
   if(!event&&!review)publishShadow(ctx,prepared);
   status(ctx,review?'想法 · 候选已准备，/inner-loop say 确认发送':event?'想法 · 有候选，/inner-loop show 查看':'想法 · 预览已显示');
  }).catch(()=>{if(!stale&&epoch===core.epoch)status(ctx,'想法 · 本次已停止（材料、预算或输出不可用）')}).finally(()=>{
   work=null;const next=queued;queued=null;
   if(next&&!stale&&next.epoch===core.epoch)launch(next.ctx,{event:next.event,review:next.review});
  });
  status(ctx,'想法 · 正在探索');
 };
 pi.on('session_start',(_event,ctx)=>{
  stale=false;reset();unsubscribe?.();attention?.dispose();
  if(ctx.mode==='tui'){
   attention=observeTerminalAttention(()=>{cancel();status(ctx,'想法 · 终端交互已取消本次探索')});
   unsubscribe=ctx.ui.onTerminalInput?.(data=>{
   if(data==='\x1b[I'||isTerminalRelease(data))return undefined;
   if(core.episode||pending!==null){cancel();status(ctx,'想法 · 输入已取消本次探索')}
   return undefined;
  });
  }
  status(ctx,'想法 · 关闭');
 });
 pi.on('session_tree',(_event,ctx)=>{reset();status(ctx,'想法 · 关闭')});
 pi.on('session_shutdown',()=>{reset();unsubscribe?.();unsubscribe=undefined;attention?.dispose();attention=undefined;stale=true});
 pi.on('input',(event,ctx)=>{cancel();armedUser=ctx.mode==='tui'&&event.source==='interactive'?event.text:null;if(armedUser!==null)attention?.noteInteraction()});
 pi.on('before_agent_start',(event,ctx)=>{
  const selected=armedUser;armedUser=null;
  cancel();
  if(ctx.mode!=='tui'||!capture||core.mode!=='shadow'||event.messageType!=='user'||event.prompt!==selected||event.prompt.startsWith('/'))return;
  const text=event.prompt.trim();
  if(!text||text.length>400||Buffer.byteLength(text)>900){status(ctx,'想法 · 消息较长，本次未选为材料');return}
  const id='user-'+createHash('sha256').update(text).digest('hex').slice(0,16);
  core.notes=core.notes.filter(n=>n.id!==id).slice(-2);
  while(core.notes.length&&Buffer.byteLength([...core.notes.map(n=>n.text),text].join(''))>900)core.notes.shift();
  core.add(text,id);pending=core.epoch;
 });
 pi.on('message_end',(event,ctx)=>{
  if(!capture||pending!==core.epoch||event.message.role!=='assistant')return;
  if(['error','aborted'].includes(event.message.stopReason)||event.message.errorMessage){cancel();status(ctx,'想法 · 普通回复未完成，本次不补充');return}
  const text=event.message.content.filter(p=>p.type==='text').map(p=>p.text).join('').slice(0,200);
  if(text)core.history=[...core.history,text].slice(-4);
 });
 pi.on('agent_settled',(event,ctx)=>{const armed=pending;pending=null;if(!event.aborted&&automatic&&armed===core.epoch)launch(ctx,{event:true})});
 const command={
  description:'TUI 想法：auto（自动开口）/ auto-shadow / shadow / add <话题> / capture on|off / run / prepare / show / say / cancel / off / status',
  handler:async(args,ctx)=>{
   const [action,...rest]=args.trim().split(/\s+/);
   try{
    if(action==='off'||action==='clear'){reset();status(ctx,'想法 · 关闭');ctx.ui.notify('已关闭并清空话题授权。','info');return}
    if(action==='cancel'){cancel();automatic=false;autoSpeak=false;capture=false;armedUser=null;status(ctx,'想法 · 已取消，自动探索关闭');return}
    if(ctx.mode!=='tui')throw Error('仅支持 TUI。');
    attention?.noteInteraction();
    if(action==='shadow'||action==='auto'||action==='auto-shadow'){
     cancel();core.mode='shadow';automatic=action!=='shadow';autoSpeak=action==='auto';capture=autoSpeak&&rest[0]!=='cards';
     ctx.ui.notify(autoSpeak?(capture?'自动发言已开启：只用随后短消息及回复片段，有新补充时自行说一条；输入或取消即作废。':'自动发言已开启：只用显式话题卡。'):automatic?'事件驱动 shadow 已开启：候选只保留供查看。':'手动 shadow 已开启。添加话题后用 /inner-loop run。','info');
     status(ctx,autoSpeak?'想法 · 自动发言，等待新话题':'想法 · 仅预览');
     if(autoSpeak&&core.notes.length)launch(ctx,{event:true});
    }else if(action==='capture'){
     if(core.mode!=='shadow'||!['on','off'].includes(rest[0]))throw Error('先开启 shadow/auto，再使用 capture on 或 off。');
     cancel();capture=rest[0]==='on';if(capture)automatic=true;
     ctx.ui.notify(capture?'已授权后续短消息及回复前 200 字符用于探索；不读取旧聊天、思考或工具结果。':'已停止选取后续消息，已有话题卡仍按当前模式处理。','info');
    }else if(action==='add'){
     if(core.mode!=='shadow')throw Error('先使用 /inner-loop shadow 或 auto。');
     const text=rest.join(' ');if(Buffer.byteLength([...core.notes.map(n=>n.text),text].join(''))>900)throw Error('材料太长，请精简为几句短话。');
     core.add(text);prepared=null;ctx.ui.notify(`已授权 ${core.notes.length} 张话题卡。`,'info');
     if(automatic)launch(ctx,{event:true});
    }else if(action==='run'||action==='prepare'||action==='once'){
     if(core.mode!=='shadow')throw Error('先开启 shadow，并添加话题。');
     if(!available(ctx)||!core.notes.length||core.episode)throw Error('需要空闲 TUI、空编辑器、无排队消息，且至少一张话题卡。');
     if(action!=='run'){automatic=false;autoSpeak=false;capture=false}
     prepared=null;launch(ctx,{review:action!=='run'});
    }else if(action==='show'){
     if(!prepared)throw Error('当前没有候选。');publishShadow(ctx,prepared);
    }else if(action==='say'){
     const item=prepared;
     if(!item||!available(ctx)||item.epoch!==core.epoch||item.session!==ctx.sessionManager.getSessionId())throw Error('候选已失效，请重新准备。');
     if(!saved(ctx))throw Error('请先完成一轮普通对话，再确认发送。');
     const persisted=deliver(ctx,item);automatic=false;autoSpeak=false;capture=false;core.mode='off';core.notes=[];
     ctx.ui.notify(persisted?'已保存并显示这一条想法；没有触发主模型。':'保存状态未确认，未重试。','info');
    }else ctx.ui.notify(`想法：${autoSpeak?'auto 自动发言':core.mode}；话题 ${core.notes.length}；自动探索 ${automatic?'开':'关'}；后续消息授权 ${capture?'开':'关'}；${core.episode?'探索中':prepared?'有候选':'空闲'}。`,'info');
   }catch(error){ctx.ui.notify(String(error),'warning')}
  }
 };
 pi.registerCommand('inner-loop',command);
 return Object.assign(core,{getTuiState:()=>({automatic,autoSpeak,capture,pending,prepared}),handleCommand:command.handler,invalidate:cancel,waitForWork:()=>work??Promise.resolve()});
}
