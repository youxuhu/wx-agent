/** Versioned UI-only bridge. Never schedules a review or modifies its policy. */
export function attachWatchdogBridge(pi,runtime){
  let ctx; let phase='idle'; let sequence=0;
  function publish(){if(!ctx)return;const s=runtime.getSnapshot();pi.events.emit('pi-subagents:watchdog-state:v1',{version:1,sessionId:ctx.sessionManager.getSessionId(),sequence:++sequence,model:ctx.model?`${ctx.model.provider}/${ctx.model.id}`:null,thinking:s.config.main.thinking??ctx.thinkingLevel,phase:!s.configOk?'error':!s.enabled?'off':phase});}
  for(const name of ['bindSession','reset','handleModelChange','refreshConfig','setSessionEnabled']){
    if(typeof runtime[name]!=='function')continue;const original=runtime[name];runtime[name]=function(...args){if(name==='bindSession')ctx=args[0];const result=original.apply(this,args);if(name==='reset'||name==='bindSession'||name==='handleModelChange')phase='idle';queueMicrotask(publish);return result};
  }
  const original=runtime.reviewDelta;
  runtime.reviewDelta=async function(...args){const epoch=this.epoch;phase='reviewing';publish();try{const result=await original.apply(this,args);if(epoch===this.epoch){phase=result==='timeout'?'timeout':result==='stale'?'idle':this.status==='failed'?'error':this.lastWarning&&['displayed','stalemate'].includes(this.lastWarning.state)?this.lastWarning.severity==='blocker'?'blocker':'concern':'clear';publish()}return result}catch(e){if(epoch===this.epoch){phase='error';publish()}throw e}};
  const off=pi.events.on('pi-subagents:watchdog-query:v1',publish);const dispose=runtime.dispose;runtime.dispose=function(...args){off();ctx=undefined;return dispose.apply(this,args)};
}
