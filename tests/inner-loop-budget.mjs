import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCaller} from '../extensions/inner-loop/caller.mjs';
const root=await mkdtemp(join(tmpdir(),'inner-budget-'));
const ledger=join(root,'outputs/inner-loop-integration/budget.json');
let requests=0;
const model={id:'deepseek-flash',api:'openai-completions',baseUrl:'https://api.deepseek.com',cost:{input:1,output:2}};
const runtime=async()=>({getModel:()=>model,streamSimple(){requests++;return {[Symbol.asyncIterator]:async function*(){},result:async()=>({stopReason:'error',errorMessage:'synthetic failure',usage:{input:0,output:0}})}}});
const call=createCaller(runtime,root),signal=new AbortController().signal;
try{
 await assert.rejects(call('JSON','{}',signal),/reservation retained/);
 const state=JSON.parse(await readFile(ledger,'utf8'));
 assert.equal(state.calls,75);assert(state.tokens>31922);assert(state.usd>0.0285492);
 await writeFile(join(root,'outputs/inner-loop-integration/budget.lock'),'fixture');
 await assert.rejects(call('JSON','{}',signal),/EEXIST/);assert.equal(requests,1);
 await rm(join(root,'outputs/inner-loop-integration/budget.lock'));
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(call('JSON','{}',cancelled.signal),/Cancelled/);assert.equal(requests,1);
 await writeFile(ledger,JSON.stringify({...state,calls:192}));await assert.rejects(call('JSON','{}',signal),/exhausted/);assert.equal(requests,1);
 await writeFile(ledger,JSON.stringify({...state,calls:'broken'}));await assert.rejects(call('JSON','{}',signal),/Corrupt/);assert.equal(requests,1);
 console.log('PASS: integration ledger inherits study spending, retains error reservations, locks concurrent IO and blocks cancelled/exhausted/corrupt budgets.');
}finally{await rm(root,{recursive:true,force:true})}
