import {ModelRuntime, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {ShadowController} from './controller.mjs';
import {createCaller} from './caller.mjs';

export function install(pi: ExtensionAPI, call: (system:string,text:string,signal:AbortSignal)=>Promise<unknown>) {
 const controller=new ShadowController(call);
 pi.on('session_start',()=>controller.reset());
 pi.on('session_tree',()=>controller.reset());
 pi.on('session_shutdown',()=>controller.reset());
 pi.on('before_agent_start',()=>controller.cancel());
 pi.on('input',()=>{controller.cancel()});
 pi.registerCommand('inner-loop',{
  description:'Manual shadow experiment: shadow | add <card> | run | cancel | clear | off | status',
  handler:async(args,ctx)=>{
   const [action,...rest]=args.trim().split(/\s+/);
   try{
    if(action==='off'||action==='clear'){controller.reset();ctx.ui.notify('Inner Loop off; cards and preview cleared.','info');return}
    if(action==='cancel'){controller.cancel();ctx.ui.notify('Inner Loop cancelled.','info');return}
    if(ctx.mode!=='tui')throw Error('Inner Loop requires TUI; web/RPC attention and writer signals are not connected.');
    if(action==='shadow'){controller.cancel();controller.mode='shadow';ctx.ui.notify('Shadow enabled for this session. Add cards, then run explicitly. No automatic speech.','info')}
    else if(action==='add'){controller.add(rest.join(' '));ctx.ui.notify(`Authorized cards: ${controller.notes.length}`,'info')}
    else if(action==='run'){
     const epoch=controller.epoch;
     // Return command control immediately so /cancel and new input can invalidate work.
     void controller.run(ctx).then(result=>{
      if(controller.result!==result)return;
      pi.sendMessage({customType:'inner-loop-shadow',content:result.wouldSpeak?`[Inner Loop shadow — not sent proactively]\n${result.message}`:`[Inner Loop shadow] Silent: ${result.reason}`,
       display:true,details:{origin:'inner-loop',mode:'shadow',delivered:false,reason:result.reason}}, {triggerTurn:false});
     }).catch(()=>{if(controller.epoch===epoch)ctx.ui.notify('Inner Loop stopped; no preview published. Check mode, cards, attention or budget.','warning')});
    }else ctx.ui.notify(`Inner Loop: ${controller.mode}; cards=${controller.notes.length}; running=${!!controller.episode}. Commands: shadow, add <card>, run, cancel, clear, off, status.`,'info');
   }catch(error){ctx.ui.notify(String(error),'warning')}
  }
 });
 return controller;
}
export default function(pi: ExtensionAPI){
 let runtime:Promise<ModelRuntime>|undefined;
 install(pi,createCaller(()=>runtime??=ModelRuntime.create({allowModelNetwork:false}),process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent')));
}
