import {normalized} from './graph.mjs';
export function stamp(live){return JSON.stringify([live.workspace,live.session,live.epoch,live.grantRevision,live.version,live.allowedIds,live.notes])}
export function gate(live,owner,{candidate=null,graph=null}={}){
 if(live.mode!=='shadow'||live.optIn!==true)return 'not-opted-in';
 if(stamp(live)!==owner)return 'stale-owner';
 if(live.connected!==true)return 'disconnected';
 if(live.active!==true)return 'inactive-workspace';
 if(live.lease!==true)return 'no-writer-lease';
 if(live.attention!=='idle'||live.busy!==false||live.quiet!==false)return 'attention-unavailable';
 if(candidate){
   if(!graph?.validateRefs(candidate.refs))return 'invalid-evidence';
   if(candidate.refs.some(r=>!live.allowedIds.includes(r.id)))return 'revoked-source';
   if((live.deliveredBasis??[]).includes(graph.basis(candidate.refs)))return 'duplicate-basis';
   if((live.history??[]).some(t=>normalized(t)===normalized(candidate.text)))return 'duplicate-text';
 }
 return null;
}
export function externalEvent(event){
 return !!event&&event.origin==='user'&&['conversation-settled','notes-changed'].includes(event.type)&&typeof event.id==='string'&&!!event.id;
}
