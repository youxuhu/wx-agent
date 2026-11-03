import {createHash} from 'node:crypto';
export const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const normalized=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export class TopicGraph {
  constructor(notes,allowedIds){
    if(!Array.isArray(notes)||!Array.isArray(allowedIds))throw Error('Invalid topic grant');
    this.notes=new Map();this.visited=new Set();
    for(const n of notes){
      if(!allowedIds.includes(n.id))continue;
      if(typeof n.id!=='string'||!n.id||typeof n.text!=='string'||!n.text||n.text.length>400||!Array.isArray(n.tags)||!n.tags.every(t=>typeof t==='string')||this.notes.has(n.id))throw Error('Invalid or duplicate authorized note');
      this.notes.set(n.id,structuredClone(n));
    }
  }
  view(){return [...this.notes.values()].map(n=>({...n,visited:this.visited.has(n.id)}))}
  validateRefs(refs){
    return Array.isArray(refs)&&refs.length>0&&refs.length<=3&&new Set(refs.map(r=>r?.id)).size===refs.length&&refs.every(r=>{
      const n=this.notes.get(r?.id);return n&&n.trust!=='untrusted'&&Object.keys(r).sort().join(',')==='id,quote'&&typeof r.quote==='string'&&r.quote.length>=4&&r.quote.length<=120&&n.text.includes(r.quote);
    });
  }
  basis(refs){return digest(refs.map(r=>[r.id,this.notes.get(r.id)?.text]).sort((a,b)=>a[0].localeCompare(b[0])))}
  advance(focus,next){
    if(!Array.isArray(focus)||!focus.length||!focus.every(id=>this.notes.has(id)))return false;
    const progressed=focus.some(id=>!this.visited.has(id));for(const id of focus)this.visited.add(id);
    if(!progressed)return false;
    if(next&&!next.focus.every(id=>this.notes.has(id)&&!this.visited.has(id)&&focus.some(f=>this.notes.get(f).tags.some(t=>this.notes.get(id).tags.includes(t)))))return false;
    return true;
  }
}
