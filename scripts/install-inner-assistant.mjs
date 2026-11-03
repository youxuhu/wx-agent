#!/usr/bin/env node
import {symlink,readlink,lstat,chmod} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'../assistants/inner/cli.mjs');
const flag=process.argv.indexOf('--bin-dir');
const dir=flag===-1?dirname(execFileSync('which',['pi'],{encoding:'utf8'}).trim()):resolve(process.argv[flag+1]);
const target=join(dir,'pi-chat');
await chmod(source,0o755);
const existing=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e});
if(existing){if(!existing.isSymbolicLink()||resolve(dir,await readlink(target))!==source)throw Error(`Will not replace existing command: ${target}`)}
else await symlink(source,target);
console.log(`Installed ${target}\nStart: pi-chat`);
