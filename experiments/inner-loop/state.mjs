import {TopicGraph} from './graph.mjs';
import {stamp,gate,externalEvent} from './policy.mjs';
import {validateStep,validateDecision,evidenceIds} from './measure.mjs';
export class Episode {
 constructor(live={},{maxExplore=3,event={origin:'user',type:'conversation-settled',id:'synthetic'}}={}){
   if(!Number.isInteger(maxExplore)||maxExplore<1||maxExplore>3)throw Error('Invalid exploration limit');
   if(!['off','shadow'].includes(live.mode??'off'))throw Error('Active delivery is not implemented or authorized');
   this.live=live;this.snapshot=structuredClone(live);this.owner=stamp(live);this.graph=new TopicGraph(live.notes??[],live.allowedIds??[]);
   this.maxExplore=maxExplore;this.steps=0;this.assessed=false;this.terminal=!externalEvent(event);this.candidate=null;this.controller=new AbortController();this.sent=0;
   const eventKey=JSON.stringify([live.workspace,live.session,live.epoch,event.id]);
   live.usedEvents??=[];
   if(live.usedEvents.includes(eventKey))this.terminal=true;
   else if(!this.terminal)live.usedEvents.push(eventKey);
 }
 view(){return {interest:this.snapshot.interest,open:this.snapshot.open,attention:this.snapshot.attention,history:this.snapshot.history,notes:this.graph.view()}}
 preflight(){return this.terminal?'terminal':this.controller.signal.aborted?'cancelled':gate(this.live,this.owner)}
 acceptStep(step){
   const blocked=this.preflight();if(blocked)return {ok:false,reason:blocked};
   if(this.explorationEnded)return {ok:false,reason:'exploration-ended'};
   if(this.steps>=this.maxExplore){this.terminal=true;return {ok:false,reason:'exploration-cap'}}
   this.steps++;
   if(!validateStep(step,this.graph)){this.terminal=true;return {ok:false,reason:'invalid-step'}}
   if(step.action==='hold'){this.terminal=true;return {ok:true,reason:'model-hold'}}
   if(!this.graph.advance(step.focus,step.next)){this.terminal=true;return {ok:false,reason:'no-progress-or-invalid-frontier'}}
   if(step.candidate)this.candidate=structuredClone(step.candidate);
   if(!step.next||this.steps===this.maxExplore)this.explorationEnded=true;
   return {ok:true,candidate:this.candidate,next:this.explorationEnded?null:step.next};
 }
 assess(decision,{anchored=false}={}){
   if(this.assessed)return {wouldSpeak:false,reason:'assessment-cap'};this.assessed=true;
   const blocked=this.preflight();if(blocked)return {wouldSpeak:false,reason:blocked};
   if(!this.candidate)return {wouldSpeak:false,reason:'no-candidate'};
   if(!validateDecision(decision,{anchored,allowedEvidence:evidenceIds(this.view())})){this.terminal=true;return {wouldSpeak:false,reason:'invalid-decision'}}
   this.decision=structuredClone(decision);
   if(decision.decision!=='speak'){this.terminal=true;return {wouldSpeak:false,reason:decision.decision}}
   return this.commit();
 }
 commit(){
   // Synchronous final gate. No external sender, notification or real-chat adapter exists.
   const blocked=this.preflight()??(!this.candidate?'no-candidate':gate(this.live,this.owner,{candidate:this.candidate,graph:this.graph}));
   if(blocked)return {wouldSpeak:false,reason:blocked};
   if(this.decision?.decision!=='speak')return {wouldSpeak:false,reason:'no-speak-decision'};
   if(this.sent>=1)return {wouldSpeak:false,reason:'message-cap'};
   this.sent++;this.terminal=true;this.live.deliveredBasis??=[];this.live.deliveredBasis.push(this.graph.basis(this.candidate.refs));
   return {wouldSpeak:true,reason:'shadow-only',message:this.candidate.text,delivered:false};
 }
 cancel(){this.controller.abort();this.terminal=true;this.candidate=null}
 restart(){throw Error('Episodes cannot resume after restart; a fresh external event and grant are required')}
}
export async function explore(episode,model){
 if(episode.preflight()||!episode.graph.notes.size)return {reason:episode.preflight()??'no-material'};
 let result;
 while(!episode.terminal&&episode.steps<episode.maxExplore){
   const step=await model(episode.view(),{signal:episode.controller.signal});
   result=episode.acceptStep(step);if(!result.ok||!result.next)break;
 }
 return result;
}
