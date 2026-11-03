import {ModelRuntime, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {installTui} from '../../extensions/inner-loop/tui.mjs';
import {createCaller} from '../../extensions/inner-loop/caller.mjs';

export const install=installTui;
export default function(pi:ExtensionAPI){
 let runtime:Promise<ModelRuntime>|undefined;
 installTui(pi,createCaller(()=>runtime??=ModelRuntime.create({allowModelNetwork:false}),process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent')));
}
