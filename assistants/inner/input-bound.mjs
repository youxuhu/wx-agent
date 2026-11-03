// Conservative request bound shared by the assistant runtime.
// Copied from the frozen study helper so production never edits or depends on study code.
export function requestInputBound(system,text){
 const wire=Buffer.byteLength(JSON.stringify([{role:'system',content:system},{role:'user',content:text}]))+64;
 return Math.max(wire,Buffer.byteLength(system+text)+256);
}
