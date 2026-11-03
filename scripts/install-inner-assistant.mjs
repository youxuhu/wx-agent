#!/usr/bin/env node
import {symlink,readlink,lstat,chmod,readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'../assistants/inner/cli.mjs');
const flag=process.argv.indexOf('--bin-dir');
const dir=flag===-1?dirname(execFileSync('which',['pi'],{encoding:'utf8'}).trim()):resolve(process.argv[flag+1]);
const target=join(dir,'pi-chat');
const packageDir=dirname(source),manifest=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));
let install=false;for(const [name,version] of Object.entries(manifest.dependencies)){try{if(JSON.parse(await readFile(join(packageDir,'node_modules',name,'package.json'),'utf8')).version!==version)install=true}catch{install=true}}
if(install)execFileSync('npm',['ci','--prefix',packageDir,'--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit'});
await chmod(source,0o755);
const existing=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e});
if(existing){if(!existing.isSymbolicLink()||resolve(dir,await readlink(target))!==source)throw Error(`Will not replace existing command: ${target}`)}
else await symlink(source,target);
console.log(`Installed ${target}\nStart: pi-chat`);
