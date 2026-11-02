import {createJiti} from './helpers.mjs';
import assert from 'node:assert/strict';import {visibleWidth} from './helpers.mjs';
const jiti=createJiti(import.meta.url);const {default:ext}=await jiti.import('../extensions/llm-speed/index.ts');const events=new Map();const bus=new Map();let renderer,scans=0;
const usage={input:100,output:30,cacheRead:900,cacheWrite:0,cost:{total:.1}};
const ctx={mode:'tui',model:{id:'deepseek-flash',provider:'deepseek',contextWindow:1000000,reasoning:true},thinkingLevel:'high',getContextUsage:()=>({percent:29,contextWindow:1000000}),sessionManager:{getSessionId:()=> 's',getCwd:()=> '/tmp/project',getSessionName:()=>'',getEntries:()=>{scans++;return [{type:'message',message:{role:'assistant',usage}}]}},ui:{setFooter:factory=>{renderer=factory({requestRender(){}},{fg:(_c,s)=>s},{onBranchChange:()=>()=>{},getGitBranch:()=> 'main',getExtensionStatuses:()=>new Map([['plan','build']]),getAvailableProviderCount:()=>1})}}};
const pi={on:(k,v)=>events.set(k,v),events:{on:(k,v)=>bus.set(k,v),emit(){}},getSettings:()=>({compaction:{modelOverrides:{'deepseek/deepseek-flash':{reserveTokens:500000}}}}),registerCommand(){}};ext(pi);await events.get('session_start')({},ctx);
for(const width of [30,60,100,160]){const lines=renderer.render(width);assert.equal(lines.length,3);assert(lines.every(l=>visibleWidth(l)<=width));if(width>=100)assert(lines.join('\n').includes('compact 50%'));console.log(width,lines.join(' / '))}assert.equal(scans,1);
bus.get('pi-subagents:watchdog-state:v1')({version:1,sessionId:'wrong',sequence:2,phase:'clear'});assert(renderer.render(160)[1].includes('watch ?'));bus.get('pi-subagents:watchdog-state:v1')({version:1,sessionId:'s',sequence:3,phase:'reviewing'});assert(renderer.render(160)[1].includes('watch reviewing'));console.log('PASS: three rows, width limits, cached stats, stale-session filtering.');

// --- speed sanity guard + session-cumulative cache (one decimal) ---
const mkCtx = entries => ({mode:'tui',model:ctx.model,thinkingLevel:'high',getContextUsage:()=>({percent:29,contextWindow:1000000}),sessionManager:{getSessionId:()=>'s2',getCwd:()=>'/tmp/project',getSessionName:()=>'',getEntries:()=>entries},ui:ctx.ui});
const drive = async (entries, {updates, waitMs=0, output=30}) => {
  await events.get('session_start')({}, mkCtx(entries));
  await events.get('message_start')({message:{role:'assistant'}}, mkCtx(entries));
  for(let i=0;i<updates;i++) await events.get('message_update')({message:{role:'assistant'}}, mkCtx(entries));
  if(waitMs) await new Promise(r=>setTimeout(r,waitMs));
  await events.get('message_end')({message:{role:'assistant',usage:{input:50,output,cacheRead:0,cacheWrite:0,cost:{total:.01}}}}, mkCtx(entries));
  return renderer.render(160);
};
// Burst delivery (2 chunks, ~0ms elapsed): must show "t/s ?", never a huge number.
// Also: cacheRead 9950 / prompt 10000 = 99.5% must keep its decimal (not round to 100%).
let lines = await drive([{type:'message',message:{role:'assistant',usage:{input:50,output:500,cacheRead:9950,cacheWrite:0,cost:{total:.1}}}}], {updates:2, output:500});
assert(lines.join('\n').includes('t/s ?'), 'burst -> t/s ?');
assert(!/\d+ t\/s/.test(lines.join('\n')), 'burst -> no numeric speed');
assert(lines[1].includes('cache 99.5%'), 'cache keeps one decimal: '+lines[1]);
assert(!lines[1].includes('cache 100%'), 'cache never rounds to 100%');
// Normal stream (4 chunks, >=0.5s): numeric speed shown, no "?".
lines = await drive([{type:'message',message:{role:'assistant',usage:{input:100,output:30,cacheRead:900,cacheWrite:0,cost:{total:.1}}}}], {updates:4, waitMs:560});
assert(/\d+ t\/s/.test(lines.join('\n')), 'normal -> numeric t/s: '+lines.join(' / '));
assert(!lines.join('\n').includes('t/s ?'), 'normal -> no "?"');
// Cumulative rate across messages (90.0%), not the latest message's 0%.
lines = await drive([{type:'message',message:{role:'assistant',usage:{input:100,output:30,cacheRead:9900,cacheWrite:0,cost:{total:.1}}}},{type:'message',message:{role:'assistant',usage:{input:1000,output:30,cacheRead:0,cacheWrite:0,cost:{total:.1}}}}], {updates:4, waitMs:560});
assert(lines[1].includes('cache 90.0%'), 'cumulative cache rate: '+lines[1]);
// Provider reports no cache at all -> "?"; no prompt tokens at all -> segment omitted.
lines = await drive([{type:'message',message:{role:'assistant',usage:{input:500,output:30,cacheRead:0,cacheWrite:0,cost:{total:.1}}}}], {updates:4, waitMs:560});
assert(lines[1].includes('cache ?'), 'no cache data -> cache ?');
lines = await drive([], {updates:4, waitMs:560});
assert(!lines[1].includes('cache'), 'no usage -> no cache segment');
console.log('PASS: burst guard shows t/s ?, cumulative cache rate with one decimal.');;
await jiti.import('../extensions/runtime-support/index.ts');
