export function requestInputBound(system,text){
 const wire=Buffer.byteLength(JSON.stringify([{role:'system',content:system},{role:'user',content:text}]))+64;
 return Math.max(wire,Buffer.byteLength(system+text)+256);
}
export class Budget{
 constructor(limits,prices,state={calls:0,tokens:0,usd:0}){
  if(![prices?.input,prices?.output].every(p=>Number.isFinite(p)&&p>0))throw Error('Unknown tariff');
  this.limits=limits;this.prices=prices;this.state={...state};
 }
 reserve(input,output=this.limits.maxOutputTokens){
  if(this.state.blocked||!Number.isInteger(input)||input<1||input>this.limits.maxInputTokens||!Number.isInteger(output)||output<1||output>this.limits.maxOutputTokens)throw Error('Invalid or blocked request budget');
  const tokens=input+output,usd=2*(input*this.prices.input+output*this.prices.output)/1e6;
  if(this.state.calls+1>this.limits.maxCalls||this.state.tokens+tokens>this.limits.maxTotalTokens||this.state.usd+usd>this.limits.maxUsd)throw Error('Experiment budget exhausted');
  this.state.calls++;this.state.tokens+=tokens;this.state.usd+=usd;return {tokens,usd,settled:false};
 }
 settle(r,usage){
  if(r.settled)throw Error('Already settled');r.settled=true;
  const input=usage?.input,output=usage?.output;
  if(!Number.isInteger(input)||input<0||!Number.isInteger(output)||output<0)return;
  const tokens=input+output,usd=2*(input*this.prices.input+output*this.prices.output)/1e6;
  if(tokens>r.tokens||usd>r.usd){this.state.tokens+=Math.max(0,tokens-r.tokens);this.state.usd+=Math.max(0,usd-r.usd);this.state.blocked=true;throw Error('Provider overran reservation')}
  this.state.tokens+=tokens-r.tokens;this.state.usd+=usd-r.usd;
 }
}
