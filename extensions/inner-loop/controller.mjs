import {randomUUID} from 'node:crypto';
import {Episode, explore} from '../../experiments/inner-loop/state.mjs';
import {generateSystem, plainSystem, generationInput, decisionInput} from '../../experiments/inner-loop/prompts.mjs';

// Bounded shadow inference. TUI delivery and explicit material selection live in tui.mjs.
export class ShadowController {
 /** @type {{id:string,text:string,tags:string[],trust:string}[]} */
 notes=[];
 /** @type {{wouldSpeak:boolean,reason:string,message?:string,delivered:false}|null} */
 result=null;
 epoch=0;
 constructor(call,prompts={generateSystem,plainSystem}){this.call=call;this.prompts=prompts;this.reset()}
 cancel(){this.episode?.cancel();this.epoch=(this.epoch??0)+1;this.episode=null;this.result=null}
 reset(){this.cancel();this.mode='off';this.notes=[];this.basis=[];this.history=[]}
 add(text,id=`card-${this.notes.length+1}`){
  if(typeof text!=='string'||!text.trim()||text.length>400||this.notes.length>=3)throw Error('Provide 1–400 characters; at most 3 cards.');
  this.cancel();this.notes.push({id,text:text.trim(),tags:['manual'],trust:'authorized'});
 }
 async run(ctx){
  if(this.mode!=='shadow')throw Error('Enable shadow explicitly first.');
  if(this.episode)throw Error('An episode is already running.');
  const available=()=>ctx.mode==='tui'&&ctx.hasUI===true&&ctx.isIdle()&&!ctx.hasPendingMessages()&&ctx.ui.getEditorText()==='';
  if(!available())throw Error('Requires an idle TUI with an empty editor and no queued messages.');
  const epoch=this.epoch,session=ctx.sessionManager.getSessionId(),workspace=ctx.cwd;
  const live={mode:'shadow',optIn:true,workspace,session,epoch,grantRevision:epoch,version:1,
   notes:structuredClone(this.notes),allowedIds:this.notes.map(n=>n.id),interest:'Explicitly selected topics.',open:'Useful supported connection.',
   history:[...this.history],attention:'idle',busy:false,quiet:false,connected:true,active:true,lease:true,deliveredBasis:[...this.basis]};
  const e=new Episode(live,{event:{origin:'user',type:'notes-changed',id:randomUUID()}});this.episode=e;
  const check=()=>{
   if(epoch!==this.epoch||!available()||ctx.cwd!==workspace||ctx.sessionManager.getSessionId()!==session)e.cancel();
   if(e.controller.signal.aborted)throw Error('Episode invalidated; no preview published.');
  };
  const call=async(system,text)=>{check();const out=await this.call(system,text,e.controller.signal);check();return out};
  try{
   await explore(e,view=>call(this.prompts.generateSystem,generationInput(view)));
   check();
   const result=e.candidate&&!e.terminal?e.assess(await call(this.prompts.plainSystem,decisionInput(e.view(),e.candidate))):{wouldSpeak:false,reason:e.preflight()??'no-candidate',delivered:false};
   check();this.result={...result,delivered:false};this.basis=[...(live.deliveredBasis??[])];return this.result;
  }finally{if(this.episode===e)this.episode=null}
 }
}
