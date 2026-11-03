// Bounded NEW playground integration probe. Never reruns the frozen 48-scene study.
import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {sdk,agentDir} from './helpers.mjs';import {fixture} from './inner-assistant-fixture.mjs';import {createAssistant} from '../assistants/inner/runtime.mjs';import {reviewSystem,validReview} from '../assistants/inner/play-loop.mjs';import {createCaller} from '../extensions/inner-loop/caller.mjs';
if(!process.argv.includes('--execute'))throw Error('Explicit --execute required for paid integration.');
const root=await mkdtemp(join(tmpdir(),'inner-play-paid-'));let app,calls=0;const trace=[];
try{
 let rt;const real=createCaller(()=>rt??=sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),allowModelNetwork:false,refreshOnCreate:false}),agentDir);
 app=await createAssistant({profileDir:root,modelRuntime:await fixture(sdk,root),provider:'inner-fixture',model:'conversation',innerCall:async(system,text,signal)=>{if(calls>=12)throw Error('Probe resource allowance exhausted');calls++;const result=await real(system,text,signal);trace.push({request:JSON.parse(text),result});return result}});
 let ui;
 if(process.argv.includes('--tui')){ui=new sdk.InteractiveMode(app.runtime,{tuiMode:'regular'}).run();while(app.loop.state.reason==='new')await new Promise(r=>setTimeout(r,10))}
 else await app.runtime.session.bindExtensions({mode:'tui',uiContext:{notify(){},getEditorText:()=>'',setStatus(){},onTerminalInput:()=>()=>{}}});
 await app.loop.wait();
 const reviews=[];
 for(const [label,before,after,next] of [
 ['paraphrase','握持稳定和隔热需要分别考虑。','隔热和握持稳定需要分开考虑。','再换一种说法'],
 ['constraint','无把手杯子可以用双层壁或外加套。','新增约束：只许一种材料且不可拆件。外加套被排除，剩下形状或壁厚变化。','比较凹槽和双层壁的取舍']]){
  const value=await real(reviewSystem,JSON.stringify({action:'write',evidence:{before,after},previous:[],alreadySaid:[],message:null,next,unansweredCharacters:0}),new AbortController().signal);reviews.push({label,result:value});
 }

 const report={calls,reviewCalls:2,reviews,state:app.loop.state,files:app.space.list(),trace,budget:JSON.parse(await readFile(join(agentDir,'outputs/inner-loop-integration/budget.json'),'utf8'))};await writeFile(join(agentDir,'outputs/inner-loop-integration/playground-paid.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 await writeFile(join(agentDir,`outputs/inner-loop-integration/playground-paid-${report.budget.calls}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({calls,steps:report.state.steps,messages:report.state.messages,reason:report.state.reason,reviews,budget:report.budget}));
 if(ui){console.log('INNER_PAID_PROBE_FINISHED');await ui}
 assert(reviews.every(r=>validReview(r.result)));assert.equal(reviews[0].result.progress,false);assert.equal(reviews[1].result.progress,true);assert(report.state.steps>0,'Real model must complete at least one reviewed action');
}finally{await app?.runtime.dispose();await rm(root,{recursive:true,force:true})}
