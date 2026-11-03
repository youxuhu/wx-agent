import * as fs from 'node:fs';
import {join,dirname,relative,isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import {hash} from './playground.mjs';
const here=dirname(fileURLToPath(import.meta.url)),agent=resolve(here,'../..');
const quoted=s=>"'"+s.replaceAll("'","'\\''")+"'";
const within=(root,path)=>path===root||path.startsWith(root+'/');
export class ToolGateway {
 constructor({profile,space,core,ledger,getSearchKey=async()=>undefined}){this.profile=profile;this.space=space;this.core=core;this.ledger=ledger;this.getSearchKey=getSearchKey;this.plugin=fs.realpathSync(join(agent,'npm/node_modules/pi-web-access'));this.cache=join(profile,'tool-cache');fs.mkdirSync(this.cache,{recursive:true,mode:0o700});this.accessFile=join(profile,'file-access.json');this.readRoots=fs.existsSync(this.accessFile)?JSON.parse(fs.readFileSync(this.accessFile,'utf8')):[];this.hashes=new Map();this.queue=Promise.resolve();this.pending=new Map();this.status='not-started';this.stderr='';this.closed=false}
 allowRead(path){const root=fs.realpathSync(path);if(!fs.statSync(root).isDirectory()||within(root,this.profile)||within(this.profile,root)||within(root,agent)||within(agent,root))throw Error('Select a separate data directory, not configuration or assistant internals');if(!this.readRoots.includes(root))this.readRoots.push(root);fs.writeFileSync(this.accessFile,JSON.stringify(this.readRoots)+'\n',{mode:0o600});if(this.config){this.config={...this.config,filesystem:{...this.config.filesystem,allowRead:[...this.config.filesystem.allowRead,root]}};this.sandbox.updateConfig(this.config);this.stop('File permissions changed; restarting worker')}return root}
 revokeRead(path){let root;try{root=fs.realpathSync(path)}catch{root=resolve(path)}this.readRoots=this.readRoots.filter(r=>r!==root);fs.writeFileSync(this.accessFile,JSON.stringify(this.readRoots)+'\n',{mode:0o600});if(this.config){this.config={...this.config,filesystem:{...this.config.filesystem,allowRead:this.config.filesystem.allowRead.filter(r=>r!==root)}};this.sandbox.updateConfig(this.config);this.stop('File permission revoked')}return root}
 location(path,write=false){if(typeof path!=='string'||path.length>500)throw Error('Invalid file path');let abs=isAbsolute(path)?resolve(path):resolve(this.space.root,path);for(const alias of ['/tmp','/var'])if(within(alias,abs)){try{abs=resolve(fs.realpathSync(alias),relative(alias,abs))}catch{}}let root=this.space.root;if(!within(root,abs)){if(write)throw Error('Writes are restricted to playground');root=this.readRoots.find(r=>within(r,abs));if(!root)throw Error('File outside allowed roots')}
  if(/(^|\/)(auth\.json|web-search\.json|sandbox\.json|budget-policy\.json|settings\.json)$/i.test(abs)&&root!==this.space.root)throw Error('Configuration/credential files are not readable');return {root,path:relative(root,abs),abs}}
 async init(){if(this.status==='ready')return;const module=join(agent,'extensions/sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js');const {SandboxManager}=await import(pathToFileURL(module).href);this.sandbox=SandboxManager;
  if(!SandboxManager.isSupportedPlatform())throw Error('OS sandbox unavailable; tools remain disabled');
  const readAllowed=[here,join(agent,'npm/node_modules'),this.space.root,this.cache,...this.readRoots];
  this.config={network:{allowedDomains:['api.deepseek.com'],deniedDomains:[],allowLocalBinding:false,allowMachLookup:['com.apple.mDNSResponder','com.apple.dnssd','com.apple.system.opendirectoryd.libinfo']},filesystem:{denyRead:[homedir(),'/tmp','/private/tmp','/private/var/folders'],allowRead:readAllowed,allowWrite:[this.space.root,this.cache],denyWrite:[]}};
  await SandboxManager.initialize(this.config);this.status='ready';
 }
 async start(){if(this.child)return;await this.init();
  fs.writeFileSync(join(this.cache,'web-search.json'),JSON.stringify({webSearch:{provider:'deepseek',allowedProviders:['deepseek']},fetch:{allowedModes:['readable'],defaultMode:'readable'},maxInlineContentChars:2400,workflow:'none'}),{mode:0o600});
  this.sandbox.updateConfig(this.config);const command=await this.sandbox.wrapWithSandbox(quoted(process.execPath)+' '+quoted(join(here,'tool-worker.mjs')));
  const env={PATH:process.env.PATH??'/usr/bin:/bin',TMPDIR:this.cache,TERM:'dumb',PI_CODING_AGENT_DIR:this.cache,INNER_PI_CORE:this.core,INNER_WEB_PLUGIN:this.plugin,PI_OFFLINE:'1'};
  this.child=spawn('/bin/bash',['-c',command],{cwd:this.cache,env,detached:true,stdio:['pipe','pipe','pipe']});let buf='';const child=this.child;
  child.stdout.on('data',data=>{buf+=data;for(let pos;(pos=buf.indexOf('\n'))>=0;){const line=buf.slice(0,pos);buf=buf.slice(pos+1);if(!line.startsWith('INNER_RESULT '))continue;let r;try{r=JSON.parse(line.slice(13))}catch{continue}const task=this.pending.get(r.id);if(task){this.pending.delete(r.id);r.error?task.reject(Error(r.error)):task.resolve(r.result)}}if(buf.length>2000000)this.stop('Worker output exceeded bound')});
  child.stderr.on('data',data=>{this.stderr=(this.stderr+data).slice(-1500)});child.on('error',e=>this.stop(e.message));child.on('exit',()=>{if(this.child===child)this.stop('Sandbox worker exited: '+this.stderr.slice(-400))});
 }
 stop(reason='cancelled'){const child=this.child;this.child=null;if(child?.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}for(const task of this.pending.values())task.reject(Error(reason));this.pending.clear()}
 request(op,args={},signal){const run=this.queue.then(()=>this.execute(op,args,signal));this.queue=run.catch(()=>{});return run}
 async execute(op,args,signal){if(this.closed||signal?.aborted)throw Error('Cancelled');let location;
  if(['read','full','write'].includes(op))location=this.location(args.path,op==='write');
  let domains=['api.deepseek.com'];let pinnedAddress,reservation;if(op==='search'&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>240))throw Error('One short search query required');
  if(op==='fetch'){const url=new URL(args.url);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hostname.endsWith('.local')||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.internal')||url.hostname.endsWith('.lan')||url.hostname==='localhost'||url.hostname.includes(':')||/^\d+(\.\d+){3}$/.test(url.hostname)||/youtube|youtu\.be/i.test(url.hostname)||/\.(pdf|mp4|zip|png|jpg|git)(?:$|\?)/i.test(url.pathname)||url.hostname==='github.com')throw Error('Only public HTTPS text pages supported; use raw GitHub file URLs');reservation=this.ledger?.external('fetch',0);const endpoint=new URL('https://cloudflare-dns.com/dns-query');endpoint.searchParams.set('name',url.hostname);endpoint.searchParams.set('type','A');const {stdout}=await promisify(execFile)('curl',['--disable','--fail','--silent','--show-error','--max-time','10','--header','accept: application/dns-json',endpoint.href],{timeout:12000,maxBuffer:32768,signal});const dns=JSON.parse(stdout);const addresses=(dns.Status===0?dns.Answer??[]:[]).filter(a=>a.type===1&&isIP(a.data)===4).map(a=>({address:a.data,family:4}));if(!addresses.length)throw Error('Public DNS resolution unavailable');const {createJiti}=await import(pathToFileURL(join(this.core,'node_modules/jiti/lib/jiti.mjs')).href);const {validateRemoteUrl}=await createJiti(import.meta.url,{fsCache:false}).import(join(this.plugin,'ssrf-protection.ts'));await validateRemoteUrl(url,{lookup:async()=>addresses,allowRanges:[],trustEnvProxy:false});pinnedAddress=addresses[0].address;domains.push(url.hostname,pinnedAddress)}
  try{await this.start()}catch(e){this.status='unavailable';throw Error('Sandbox unavailable: '+e.message)}
  this.sandbox.updateConfig({...this.config,network:{...this.config.network,allowedDomains:domains},filesystem:{...this.config.filesystem,allowRead:[...this.config.filesystem.allowRead,...this.readRoots]}});
  const key=op==='search'?await this.getSearchKey():undefined;if(op==='search'&&!key)throw Error('DeepSeek search credential unavailable');
  if(op==='search')reservation=this.ledger?.external('search',.0015);
  if(op==='write'&&args.append&&!this.hashes.has(location.abs)&&fs.existsSync(location.abs))await this.execute('full',{path:args.path},signal);
  const id=randomUUID();const payload={id,op,args:{...args,...(pinnedAddress?{pinnedAddress}:{}),...(location?{path:location.path}:{})},root:location?.root??this.space.root,...(key?{key}:{})};
  if(op==='write'){const expected=args.expectedHash??this.hashes.get(location.abs);payload.args.expectedHash=expected??hash('')}
  const abort=()=>this.stop('Cancelled');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>this.stop('Tool timeout'),30000);
  try{if(signal?.aborted)throw Error('Cancelled');const result=await new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify(payload)+'\n',error=>{if(error){this.pending.delete(id);reject(error)}})});if(signal?.aborted)throw Error('Cancelled');if(location&&['read','full'].includes(op))this.hashes.set(location.abs,result.hash);if(location&&op==='write')this.hashes.set(location.abs,result.afterHash);if(reservation)this.ledger.finishExternal(reservation);return result}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
 }
 async close(){this.closed=true;this.stop('shutdown');await this.queue;await this.sandbox?.reset()}
}
