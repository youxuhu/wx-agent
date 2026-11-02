import {existsSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export const agentDir=process.env.PI_TEST_AGENT_DIR??process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent');
export function resolveCore(){
 if(process.env.PI_CORE_DIR)return process.env.PI_CORE_DIR;
 const beside=join(dirname(process.execPath),'pi');
 if(existsSync(beside)){
  let p=dirname(realpathSync(beside));
  while(dirname(p)!==p){if(existsSync(join(p,'dist/index.js'))&&existsSync(join(p,'package.json')))return p;p=dirname(p)}
 }
 const root=execFileSync(process.platform==='win32'?'npm.cmd':'npm',['root','-g'],{encoding:'utf8'}).trim();
 const p=join(root,'@earendil-works/pi-coding-agent');
 if(!existsSync(join(p,'dist/index.js')))throw Error('Pi SDK unavailable; set PI_CORE_DIR');
 return p;
}
export const core=resolveCore();
const url=p=>pathToFileURL(p).href;
export const {createJiti}=await import(url(join(core,'node_modules/jiti/lib/jiti.mjs')));
export const {visibleWidth}=await import(url(join(core,'node_modules/@earendil-works/pi-tui/dist/index.js')));
export const sdk=await import(url(join(core,'dist/index.js')));
export const {initTheme}=await import(url(join(core,'dist/modes/interactive/theme/theme.js')));
