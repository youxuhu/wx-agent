import {createHash,randomUUID} from 'node:crypto';
import {existsSync,statSync,openSync,readSync,closeSync} from 'node:fs';
import {ShadowController} from './controller.mjs';
import {conversationalPrompts} from './conversation.mjs';

// Automatic TUI work prepares candidates; speech needs a fresh user say command.
export function installTui(pi,call){
 const core=new ShadowController(call,conversationalPrompts);
 let automatic=false,capture=false,pending=null,prepared=null,lastMaterial='',stale=false,unsubscribe,work=null,queued=null;
 const status=(ctx,text)=>{if(!stale)ctx.ui.setStatus?.('inner-loop',text)};
 const cancel=()=>{core.cancel();pending=null;prepared=null;queued=null};
 const reset=()=>{cancel();core.reset();automatic=false;capture=false;lastMaterial=''};
 const available=ctx=>ctx.mode==='tui'&&ctx.hasUI===true&&ctx.isIdle()&&!ctx.hasPendingMessages()&&ctx.ui.getEditorText()==='';
 const publishShadow=(ctx,item)=>{
  if(!available(ctx)||item.epoch!==core.epoch||item.session!==ctx.sessionManager.getSessionId())return;
  pi.sendMessage({customType:'inner-loop-shadow',content:`[Inner Loop shadow — 仅预览]\n${item.result.message}`,display:true,details:{origin:'inner-loop',mode:'shadow',delivered:false}},{triggerTurn:false});
 };
 const launch=(ctx,{event=false,review=false}={})=>{
  if(core.mode!=='shadow'||core.episode||!available(ctx)||!core.notes.length)return;
  if(work){queued={ctx,event,review,epoch:core.epoch};status(ctx,'想法 · 等待上一请求停止');return}
  const material=JSON.stringify(core.notes);if(event&&material===lastMaterial)return;if(event)lastMaterial=material;
  const epoch=core.epoch;
  work=core.run(ctx).then(result=>{
   if(stale||epoch!==core.epoch||core.result!==result)return;
   if(!result.wouldSpeak){status(ctx,'想法 · 暂时没有新补充');return}
   prepared={id:randomUUID(),epoch,session:ctx.sessionManager.getSessionId(),result};
   if(!event&&!review)publishShadow(ctx,prepared);
   status(ctx,review?'想法 · 候选已准备，/inner-loop say 确认发送':event?'想法 · 有候选，/inner-loop show 查看':'想法 · 预览已显示');
  }).catch(()=>{if(!stale&&epoch===core.epoch)status(ctx,'想法 · 本次已停止（材料、预算或输出不可用）')}).finally(()=>{
   work=null;const next=queued;queued=null;
   if(next&&!stale&&next.epoch===core.epoch)launch(next.ctx,{event:next.event,review:next.review});
  });
  status(ctx,'想法 · 正在探索');
 };
 pi.on('session_start',(_event,ctx)=>{
  stale=false;reset();unsubscribe?.();
  if(ctx.mode==='tui')unsubscribe=ctx.ui.onTerminalInput?.(()=>{
   if(core.episode||pending!==null){cancel();status(ctx,'想法 · 输入已取消本次探索')}
   return undefined;
  });
  status(ctx,'想法 · 关闭');
 });
 pi.on('session_tree',(_event,ctx)=>{reset();status(ctx,'想法 · 关闭')});
 pi.on('session_shutdown',()=>{reset();unsubscribe?.();unsubscribe=undefined;stale=true});
 pi.on('input',()=>cancel());
 pi.on('before_agent_start',(event,ctx)=>{
  cancel();
  if(ctx.mode!=='tui'||!capture||core.mode!=='shadow'||event.messageType!=='user'||event.prompt.startsWith('/'))return;
  const text=event.prompt.trim();
  if(!text||text.length>400||Buffer.byteLength(text)>900){status(ctx,'想法 · 消息较长，本次未选为材料');return}
  const id='user-'+createHash('sha256').update(text).digest('hex').slice(0,16);
  core.notes=core.notes.filter(n=>n.id!==id).slice(-2);core.add(text,id);pending=core.epoch;
 });
 pi.on('message_end',event=>{
  if(!capture||pending!==core.epoch||event.message.role!=='assistant')return;
  const text=event.message.content.filter(p=>p.type==='text').map(p=>p.text).join('').slice(0,200);
  if(text)core.history=[...core.history,text].slice(-4);
 });
 pi.on('agent_settled',(event,ctx)=>{const armed=pending;pending=null;if(!event.aborted&&automatic&&armed===core.epoch)launch(ctx,{event:true})});
 pi.registerCommand('inner-loop',{
  description:'TUI 想法：shadow / auto / add <话题> / capture on|off / run / prepare / show / say / cancel / off / status',
  handler:async(args,ctx)=>{
   const [action,...rest]=args.trim().split(/\s+/);
   try{
    if(action==='off'||action==='clear'){reset();status(ctx,'想法 · 关闭');ctx.ui.notify('已关闭并清空话题授权。','info');return}
    if(action==='cancel'){cancel();automatic=false;capture=false;status(ctx,'想法 · 已取消，自动探索关闭');return}
    if(ctx.mode!=='tui')throw Error('仅支持 TUI。');
    if(action==='shadow'||action==='auto'){
     cancel();core.mode='shadow';automatic=action==='auto';capture=false;
     ctx.ui.notify(automatic?'事件驱动 shadow 已开启：新话题触发探索，候选只保留供查看。':'手动 shadow 已开启。添加话题后用 /inner-loop run。','info');
     status(ctx,'想法 · 仅预览');
    }else if(action==='capture'){
     if(core.mode!=='shadow'||!['on','off'].includes(rest[0]))throw Error('先开启 shadow/auto，再使用 capture on 或 off。');
     cancel();capture=rest[0]==='on';automatic=capture;
     ctx.ui.notify(capture?'已授权后续短消息及回复前 200 字符用于 shadow；不读取旧聊天、思考或工具结果。':'已停止选取后续消息。','info');
    }else if(action==='add'){
     if(core.mode!=='shadow')throw Error('先使用 /inner-loop shadow 或 auto。');
     const text=rest.join(' ');if(Buffer.byteLength([...core.notes.map(n=>n.text),text].join(''))>900)throw Error('材料太长，请精简为几句短话。');
     core.add(text);prepared=null;ctx.ui.notify(`已授权 ${core.notes.length} 张话题卡。`,'info');
     if(automatic)launch(ctx,{event:true});
    }else if(action==='run'||action==='prepare'||action==='once'){
     if(core.mode!=='shadow')throw Error('先开启 shadow，并添加话题。');
     if(!available(ctx)||!core.notes.length||core.episode)throw Error('需要空闲 TUI、空编辑器、无排队消息，且至少一张话题卡。');
     if(action!=='run'){automatic=false;capture=false}
     prepared=null;launch(ctx,{review:action!=='run'});
    }else if(action==='show'){
     if(!prepared)throw Error('当前没有候选。');publishShadow(ctx,prepared);
    }else if(action==='say'){
     const item=prepared;
     if(!item||!available(ctx)||item.epoch!==core.epoch||item.session!==ctx.sessionManager.getSessionId())throw Error('候选已失效，请重新准备。');
     const file=ctx.sessionManager.getSessionFile();
     if(!file||!existsSync(file)||!ctx.sessionManager.getBranch().some(e=>e.type==='message'&&e.message.role==='assistant'))throw Error('请先完成一轮普通对话，再确认发送。');
     const offset=statSync(file).size;prepared=null;automatic=false;capture=false;core.mode='off';
     pi.sendMessage({customType:'inner-loop-approved',content:item.result.message,display:true,details:{origin:'inner-loop',deliveryId:item.id,mode:'user-approved-once'}},{triggerTurn:false});
     // The API returns void. Inspect only our newly appended bytes to confirm persistence.
     let persisted=false;const size=statSync(file).size-offset;
     if(size>0&&size<=65536){const fd=openSync(file,'r');try{const b=Buffer.alloc(size);readSync(fd,b,0,size,offset);persisted=b.toString().trim().split('\n').some(line=>{try{const e=JSON.parse(line);return e.type==='custom_message'&&e.details?.deliveryId===item.id}catch{return false}})}finally{closeSync(fd)}}
     core.notes=[];status(ctx,persisted?'想法 · 已保存一条，本次授权结束':'想法 · 保存未确认，已停止且不会重发');
     ctx.ui.notify(persisted?'已保存并显示这一条想法；没有触发主模型。':'保存状态未确认，未重试。','info');
    }else ctx.ui.notify(`想法：${core.mode}；话题 ${core.notes.length}；自动探索 ${automatic?'开':'关'}；后续消息授权 ${capture?'开':'关'}；${core.episode?'探索中':prepared?'有候选':'空闲'}。`,'info');
   }catch(error){ctx.ui.notify(String(error),'warning')}
  }
 });
 return Object.assign(core,{getTuiState:()=>({automatic,capture,pending,prepared})});
}
