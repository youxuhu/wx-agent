#!/usr/bin/env node
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {join} from 'node:path';

const args=process.argv.slice(2);
if(args.includes('--help')||args.includes('-h')){
 console.log('pi-chat [--new] [--regular] [--profile <dir>] [--model provider/model]\n一个聊天 demo：直接聊天，它也会在自己的活动目录里自主探索和开口。\n命令：/memory 记忆；/files 文件范围；/context 上下文；/budget 费用；/stop 停下；/new 新对话；/quit 退出。');
}else{
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('请在交互式终端运行 pi-chat；它是 TUI 助手。');
 for(let i=0;i<args.length;i++){
  if(['--auto','--new','--regular'].includes(args[i]))continue;
  if(['--profile','--model'].includes(args[i])){i++;continue}
  throw Error(`Unknown option: ${args[i]}`);
 }
 const value=flag=>{const i=args.indexOf(flag);if(i===-1)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`${flag} needs a value`);return args[i+1]};
 const profile=resolve(value('--profile')??join(homedir(),'.pi','assistants','inner'));
 process.env.PI_CODING_AGENT_DIR=profile;process.env.PI_OFFLINE='1';process.env.PI_TELEMETRY='0';
 const {createAssistant}=await import('./runtime.mjs');
 const route=value('--model'),slash=route?.indexOf('/');if(route&&(slash<=0||slash===route.length-1))throw Error('--model needs provider/model');
 const assistant=await createAssistant({profileDir:profile,fresh:args.includes('--new'),provider:route?.slice(0,slash),model:route?.slice(slash+1)});
 try{await new assistant.sdk.InteractiveMode(assistant.runtime,{tuiMode:args.includes('--regular')?'regular':'fullscreen',startupDiagnostics:assistant.runtime.diagnostics}).run()}
 finally{await assistant.runtime.dispose()}
}
