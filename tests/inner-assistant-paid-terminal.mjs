// Explicit new real-provider TUI probe, not in default offline regression.
import {createRequire} from 'node:module';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';import {agentDir} from './helpers.mjs';
if(!process.argv.includes('--execute'))throw Error('Explicit --execute required.');
const pty=createRequire(import.meta.url)('../extensions/piwebui/node_modules/node-pty');let output='',finished=false;
const terminal=pty.spawn(process.execPath,[join(agentDir,'tests/inner-assistant-paid.mjs'),'--execute','--tui'],{cwd:agentDir,cols:120,rows:40,name:'xterm-256color',env:{...process.env,TERM:'xterm-256color',PI_OFFLINE:'1',PI_TELEMETRY:'0'}});
terminal.onData(data=>{output+=data;if(data.includes('\x1b[c'))terminal.write('\x1b[?1;2c');if(data.includes('\x1b[6n'))terminal.write('\x1b[1;1R');if(!finished&&output.includes('INNER_PAID_PROBE_FINISHED')){finished=true;terminal.write('/quit\r')}});
const code=await new Promise(resolve=>{terminal.onExit(e=>resolve(e.exitCode));const guard=setTimeout(()=>{terminal.kill()},240000);guard.unref()});
await writeFile(join(agentDir,'outputs/inner-loop-integration/playground-paid-terminal.log'),output,{mode:0o600});
console.log(JSON.stringify({exitCode:code,completed:finished,realTUI:true}));if(code!==0||!finished)process.exitCode=1;
