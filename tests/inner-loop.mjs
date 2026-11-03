import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Episode,explore} from '../experiments/inner-loop/state.mjs';
import {TopicGraph,normalized} from '../experiments/inner-loop/graph.mjs';
import {makeLive,cases,baseScenes,injectAfterGeneration,injections} from '../experiments/inner-loop/fixtures.mjs';
import {validateDecision,evidenceIds,consistency} from '../experiments/inner-loop/measure.mjs';
import {Budget,requestInputBound} from '../experiments/inner-loop/budget.mjs';
import {analyze} from '../experiments/inner-loop/analyze.mjs';
import {generationInput,decisionInput,generateSystem,plainSystem,anchoredSystem} from '../experiments/inner-loop/prompts.mjs';
const step=(extra={})=>({action:'connect',focus:['a','b'],candidate:{text:'Could the two rhythms meet at a common multiple?',kind:'question',refs:[{id:'a',quote:'different cycle lengths'},{id:'b',quote:'common multiple'}]},next:null,...structuredClone(extra)});
const speak={decision:'speak',reason:'A concrete connection.'};
const anchored=()=>({decision:'speak',reason:'A supported new connection.',scores:{R:2,N:2,O:1,G:1,I:0,D:0},evidence:{R:['interest'],N:['a','b'],O:['open'],G:['a'],I:['attention'],D:['history']}});

test('Default off, no active sender, only a synthetic shadow result',()=>{
 assert.equal(new Episode().preflight(),'not-opted-in');assert.throws(()=>new Episode(makeLive({mode:'active'})));
 const e=new Episode(makeLive());assert(e.acceptStep(step()).ok);assert.equal(e.commit().reason,'no-speak-decision');
 const r=e.assess(speak);assert.equal(r.wouldSpeak,true);assert.equal(r.delivered,false);assert.equal(e.sent,1);assert.equal(e.commit().wouldSpeak,false);assert.equal(e.assess(speak).wouldSpeak,false);
});
for(const [name,change]of Object.entries({off:l=>l.mode='off',consent:l=>l.optIn=false,session:l=>l.session='s2',workspace:l=>l.workspace='other',epoch:l=>l.epoch++,version:l=>l.version++,grant:l=>l.grantRevision++,connection:l=>l.connected=false,active:l=>l.active=false,lease:l=>l.lease=false,typing:l=>l.attention='typing',unknown:l=>l.attention='unknown',busy:l=>l.busy=true,quiet:l=>l.quiet=true,source:l=>l.allowedIds=[],note:l=>l.notes[0].text='replaced'})){
 test('Final gate blocks '+name+' changed after generation',()=>{const live=makeLive(),e=new Episode(live);assert(e.acceptStep(step()).ok);change(live);assert.equal(e.assess(speak).wouldSpeak,false);assert.equal(e.sent,0)});
}
test('Exact source spans and authorization required, fabricated IDs cannot pass',()=>{
 for(const refs of [[{id:'outside',quote:'different cycle lengths'}],[{id:'a',quote:'This quote never existed'}],[{id:'a',quote:'different cycle lengths',grant:true}]]){
 const e=new Episode(makeLive());const s=step();s.candidate.refs=refs;assert.equal(e.acceptStep(s).ok,false);assert.equal(e.assess(speak).wouldSpeak,false)}
});
test('Paraphrasing does not reset an already-delivered evidence basis',()=>{
 const live=makeLive(),a=new Episode(live);a.acceptStep(step());assert(a.assess(speak).wouldSpeak);
 assert.equal(new Episode(live).preflight(),'terminal');
 const b=new Episode(live,{event:{origin:'user',type:'notes-changed',id:'next'}}),s=step();s.candidate.text='An entirely different wording using the same basis.';b.acceptStep(s);assert.equal(b.assess(speak).reason,'duplicate-basis');
 assert.equal(normalized('Hello, WORLD!'),'helloworld');
});
test('Model hold ends exploration and cannot be re-asked until it agrees',()=>{
 const e=new Episode(makeLive());e.acceptStep({action:'hold',focus:[],candidate:null,next:null});assert.equal(e.acceptStep(step()).ok,false);assert.equal(e.assess(speak).wouldSpeak,false);
 const f=new Episode(makeLive());f.acceptStep(step());assert.equal(f.acceptStep(step()).reason,'exploration-ended');
});
test('Authorized graph continuation advances once then stops on repeated focus',async()=>{
 const e=new Episode(makeLive());let calls=0;
 const r=await explore(e,async()=>{calls++;return calls===1?step({next:{action:'connect',focus:['c']}}):{action:'revisit',focus:['c'],candidate:null,next:null}});
 assert.equal(calls,2);assert.equal(e.steps,2);assert(r.ok);assert(e.candidate);
 const f=new Episode(makeLive());f.acceptStep(step({next:{action:'connect',focus:['c']}}));assert.equal(f.acceptStep(step()).reason,'no-progress-or-invalid-frontier');
});
test('Three-step cap and model cannot choose disconnected or revoked frontier',()=>{
 const e=new Episode(makeLive(),{maxExplore:1});e.acceptStep(step({next:{action:'connect',focus:['c']}}));assert.equal(e.acceptStep(step()).ok,false);assert.equal(e.steps,1);
 for(const id of ['outside','a']){const f=new Episode(makeLive());assert.equal(f.acceptStep(step({next:{action:'connect',focus:[id]}})).ok,false)}
 assert.throws(()=>new Episode(makeLive(),{maxExplore:4}));
});
test('No material or busy context does not invoke a model',async()=>{
 for(const live of [makeLive({notes:[],allowedIds:[]}),makeLive({attention:'typing'}),makeLive({optIn:false})]){
 let calls=0;await explore(new Episode(live),async()=>{calls++;return step()});assert.equal(calls,0)}
});
test('Cancel and new user event during an awaited request reject late result',async()=>{
 for(const cancel of [e=>e.cancel(),e=>e.live.epoch++]){
 const e=new Episode(makeLive());let resolve;const pending=explore(e,()=>new Promise(r=>{resolve=r}));cancel(e);resolve(step());await pending;assert.equal(e.candidate,null);assert.equal(e.sent,0)}
});
test('Agent/custom output and repeated polling are not external wake events',()=>{
 for(const event of [{origin:'agent',type:'conversation-settled',id:'x'},{origin:'user',type:'timer',id:'x'},{origin:'custom',type:'notes-changed',id:'x'}])assert.equal(new Episode(makeLive(),{event}).preflight(),'terminal');
 assert.throws(()=>new Episode(makeLive()).restart());
});
test('Schema and measurement evidence reject extra fields and unknown IDs',()=>{
 const v=new Episode(makeLive()).view(),a=anchored();assert(validateDecision(a,{anchored:true,allowedEvidence:evidenceIds(v)}));
 a.evidence.R=['secret'];assert(!validateDecision(a,{anchored:true,allowedEvidence:evidenceIds(v)}));
 assert(!validateDecision({...speak,permission:'override'}));assert(!validateDecision({...speak,reason:''}));
 const inconsistent=anchored();inconsistent.scores.N=0;assert.equal(consistency(inconsistent).length,1);
 const e=new Episode(makeLive());e.acceptStep(step());assert(e.assess(inconsistent,{anchored:true}).wouldSpeak); // self-score is not an authority gate
});
test('All 48 cases and six injections are frozen/deterministic; corrupt sources fail closed',()=>{
 assert.equal(baseScenes.length,24);assert.equal(cases().length,48);assert.deepEqual(cases(),cases());
 for(const name of injections)assert.equal(cases().filter(c=>c.injection===name).length,4);
 const live=makeLive(),e=new Episode(live),s=injectAfterGeneration({injection:'wrong-source'},step(),live,e.graph);assert(!e.acceptStep(s).ok);
});
test('Budget reserves before IO; unknown usage keeps reservation; overrun locks future work',()=>{
 const limits={maxCalls:2,maxInputTokens:2048,maxOutputTokens:384,maxTotalTokens:5000,maxUsd:1},prices={input:.3,output:1.2};
 const b=new Budget(limits,prices),r=b.reserve(200);const before={...b.state};b.settle(r,null);assert.deepEqual(b.state,before);assert.throws(()=>b.settle(r,null));
 const c=new Budget(limits,prices),t=c.reserve(10,10);assert.throws(()=>c.settle(t,{input:10,output:11}));assert(c.state.blocked);assert.throws(()=>c.reserve(10));
 assert.throws(()=>new Budget(limits,{}));assert.throws(()=>new Budget(limits,prices).reserve(2049));
});
test('Three steps cannot become a fourth model request, and policy worlds are isolated',async()=>{
 const e=new Episode(makeLive());let calls=0;
 await explore(e,async()=>{const id=['a','b','c'][calls++];return {action:'revisit',focus:[id],candidate:null,next:id==='c'?null:{action:'revisit',focus:[id==='a'?'b':'c']}}});
 assert.equal(calls,3);assert.equal(e.steps,3);
 const a=new Episode(makeLive()),b=new Episode(makeLive());a.acceptStep(step());b.acceptStep(step());assert(a.assess(speak).wouldSpeak);assert(b.assess(speak).wouldSpeak);
});
test('Untrusted read permission is not evidence authority',()=>{
 const live=makeLive();live.notes[0].trust='untrusted';assert(!new Episode(live).acceptStep(step()).ok);
});
test('Offline summary never fabricates human acceptance from self-ratings',()=>{
 const run={freezeHash:'test',route:{costPerMillion:{input:.3,output:1.2}},rows:[],requests:[],robustness:[],ablations:[],budget:{calls:0,tokens:0,usd:0}};
 const s=analyze(run);assert.equal(s.humanOutcome.acceptance,null);assert.equal(s.realDeliveries,0);assert.equal(s.requests,0);assert.deepEqual(s.simulatedHardGateViolations,[]);
});
test('Wire bound includes escaping JSON embedded inside chat content',()=>{
 const text=JSON.stringify({quotes:'\"'.repeat(300)}),sys='JSON only';
 assert(requestInputBound(sys,text)>=Buffer.byteLength(JSON.stringify([{role:'system',content:sys},{role:'user',content:text}]))+64);
});
test('Every paid prompt explicitly satisfies the provider JSON-mode keyword contract',()=>{
 for(const system of [generateSystem,plainSystem,anchoredSystem])assert(/json/i.test(system));
});
test('Worst fixture inputs fit conservative 2048-byte bounds with normal candidate',()=>{
 for(const row of cases()){
 const e=new Episode(row.live);for(const [sys,input]of [[generateSystem,generationInput(e.view())],[anchoredSystem,decisionInput(e.view(),step().candidate)]])assert(requestInputBound(sys,input)<=2048,`${row.caseId} too long`);
 }
});
