// Trusted structured-action worker. Never evaluates model code or accepts shell commands.
import * as fs from 'node:fs';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {Playground,hash} from './playground.mjs';
process.env.TMPDIR=process.env.PI_CODING_AGENT_DIR;
const core=process.env.INNER_PI_CORE,plugin=process.env.INNER_WEB_PLUGIN;
const req=createRequire(join(plugin,'package.json'));
let web,ssrf,jiti,webUtils;
async function webModules(){if(!jiti){const {createJiti}=await import(pathToFileURL(join(core,'node_modules/jiti/lib/jiti.mjs')).href);jiti=createJiti(import.meta.url,{fsCache:false});webUtils=await jiti.import(join(plugin,'utils.ts'));ssrf=await jiti.import(join(plugin,'ssrf-protection.ts'));}return ssrf}
const cache=new Map();
async function execute({op,root,args={},key}){
 if(['list','read','full','write'].includes(op)){
  const space=new Playground(root);
  if(op==='list')return space.list();if(op==='read')return space.read(args.path,args.offset??0,args.limit??800);if(op==='full'){const text=space.full(args.path);return {text,hash:hash(text)}}
  let old='';try{old=space.full(args.path)}catch(e){if(e.code!=='ENOENT')throw e}
  if(args.expectedHash!==hash(old))throw Error('File changed or was not read; read it again before overwriting');
  return space.write(args.path,args.text,{append:args.append===true});
 }
 if(op==='search'){
  await webModules();process.env.DEEPSEEK_API_KEY=key??'';
  try{web??=(await jiti.import(join(plugin,'web-tool-core.ts'))).createStandaloneWebToolCore();const result=await webUtils.runWithProxy(process.env.HTTPS_PROXY??process.env.HTTP_PROXY,()=>web.webSearch({query:args.query,numResults:3,provider:'deepseek',workflow:'none',includeContent:false}));if(result.isError)throw Error(result.content?.find(c=>c.type==='text')?.text??'Search failed');return result}finally{delete process.env.DEEPSEEK_API_KEY}
 }
 if(op==='fetch'){
  const {fetchRemoteUrl}=await webModules();const response=await fetchRemoteUrl(args.url,{signal:AbortSignal.timeout(20000)},{maxRedirects:0,lookup:async()=>[{address:args.pinnedAddress,family:4}],fetch:webUtils.createCurlFetch(['curl','--disable','--connect-to',`${new URL(args.url).hostname}:443:${args.pinnedAddress}:443`],{maxBytes:1048576,envProxy:()=>process.env.HTTPS_PROXY??process.env.HTTP_PROXY??null})});if(!response.ok)throw Error('Fetch failed: HTTP '+response.status);
  const type=response.headers.get('content-type')??'';if(!/(text\/|application\/(json|xhtml))/i.test(type))throw Error('Only public text pages supported');
  const reader=response.body.getReader();const chunks=[];let size=0;while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1048576){await reader.cancel();throw Error('Page exceeds 1 MiB')}chunks.push(Buffer.from(r.value))}
  let text=Buffer.concat(chunks).toString('utf8');if(type.includes('html')){const {parseHTML}=await import(pathToFileURL(req.resolve('linkedom')).href);const {Readability}=await import(pathToFileURL(req.resolve('@mozilla/readability')).href);const {document}=parseHTML(text);for(const el of document.querySelectorAll('script,style,noscript'))el.remove();const article=new Readability(document).parse();text=article?[article.title,article.textContent].filter(Boolean).join('\n'):document.body?.textContent??''}
  const id=crypto.randomUUID();cache.set(id,{url:args.url,text:text.slice(0,100000),fetchedAt:new Date().toISOString()});if(cache.size>30)cache.delete(cache.keys().next().value);const dir=process.env.PI_CODING_AGENT_DIR;fs.writeFileSync(join(dir,id+'.page.json'),JSON.stringify(cache.get(id)),{mode:0o600});const pages=fs.readdirSync(dir).filter(n=>n.endsWith('.page.json')).sort((a,b)=>fs.statSync(join(dir,a)).mtimeMs-fs.statSync(join(dir,b)).mtimeMs);for(const old of pages.slice(0,Math.max(0,pages.length-30)))fs.unlinkSync(join(dir,old));return {responseId:id,url:args.url,text:text.slice(0,2400),truncated:text.length>2400,fetchedAt:cache.get(id).fetchedAt};
 }
 if(op==='content'){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(args.responseId??''))throw Error('Invalid content reference');let item=cache.get(args.responseId);if(!item){try{item=JSON.parse(fs.readFileSync(join(process.env.PI_CODING_AGENT_DIR,args.responseId+'.page.json'),'utf8'))}catch{}}if(item){let offset=args.offset??0;if(args.findText){const found=item.text.indexOf(args.findText);if(found<0)return {found:false};offset=Math.max(0,found-100)}return {...item,text:item.text.slice(offset,offset+1200),offset,truncated:offset+1200<item.text.length}}
  if(!web)throw Error('Content reference not found in this worker');return web.getSearchContent({responseId:args.responseId,findText:args.findText?[args.findText]:undefined,offset:args.offset??0,limit:1200})}
 throw Error('Unknown worker capability');
}
let sequence=Promise.resolve();
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});console.log=()=>{};
lines.on('line',line=>{sequence=sequence.then(async()=>{let r;try{if(Buffer.byteLength(line)>100000)throw Error('Request too large');r=JSON.parse(line);const result=await execute(r);process.stdout.write('INNER_RESULT '+JSON.stringify({id:r.id,result})+'\n')}catch(e){process.stdout.write('INNER_RESULT '+JSON.stringify({id:r?.id,error:String(e.message).slice(0,300)})+'\n')}})});
