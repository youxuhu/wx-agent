import {purposeScope} from './budget.mjs';
export const summaryFocus='This is a conversational assistant, not necessarily a coding task. Preserve exact user constraints, exceptions, dates, uncertainty, decisions, unfinished questions, source URLs and artifact paths. Never promote a draft, fiction or untested hypothesis to user fact. Keep useful original phrases. Obey current corrections and forgotten-source exclusions. Do not include private reasoning. Use Chinese when conversation is Chinese.';
export function approximateTokens(value){const text=typeof value==='string'?value:JSON.stringify(value);const nonAscii=(text.match(/[^\x00-\x7f]/g)??[]).length;return Math.ceil((text.length-nonAscii)/3+nonAscii*1.5)}
export class ContextPolicy {
 constructor({normal=65536,extended=131072}={}){if(!Number.isSafeInteger(normal)||!Number.isSafeInteger(extended)||normal<2048||extended<normal)throw Error('Invalid context capacity');this.normal=normal;this.requestedExtended=extended;this.extended=extended;this.limit=normal;this.pending=false;this.busy=false;this.lastTokens=0;this.expanded=false}
 configure(model){const headroom=Math.min(8192,Math.floor(model.contextWindow/4));this.limit=Math.min(this.normal,Math.max(1024,model.contextWindow-headroom));this.extended=Math.min(this.requestedExtended,Math.max(this.limit,model.contextWindow-headroom));this.expanded=false;this.pending=false}
 get keepRecent(){return Math.floor(this.limit/2)}
 size(ctx,messages){const usage=ctx.getContextUsage?.();return Number.isFinite(usage?.tokens)?usage.tokens:approximateTokens(messages)}
 observe(ctx,messages){this.lastTokens=this.size(ctx,messages);if(this.lastTokens>this.limit*.875)this.pending=true}
 async settle({ctx,session,loop,query='',ledger}){if(session)this.lastTokens=this.size(ctx,session.messages);if(this.lastTokens>this.limit*.875)this.pending=true;if(this.busy||!this.pending||!ctx.isIdle()||ctx.hasPendingMessages()||ctx.ui.getEditorText()!=='')return;
  const modelWindow=ctx.model?.contextWindow??this.extended;const extended=Math.min(this.extended,modelWindow-8192);if(!this.expanded&&extended>this.limit&&/原文|细节|完整|长文|暂时不要压缩/.test(query)&&(!ledger?.read()||!ledger.read().blocked&&ledger.read().usd+.1<=(ledger.limits?.maxUsd??1))){this.limit=extended;this.expanded=true;this.pending=false;return}
  this.pending=false;if(this.lastTokens<this.limit*.93)return;
  this.busy=true;loop?.interrupt('compaction');await loop?.wait();try{await purposeScope.run('compact',()=>session.compact(summaryFocus))}finally{this.busy=false}
 }
}
