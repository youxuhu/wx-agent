#!/usr/bin/env python3
"""Idempotent, hash-guarded and atomic watchdog UI-only patch."""
import pathlib,json,sys,hashlib,os,tempfile
root=pathlib.Path(sys.argv[1]);bridge=pathlib.Path(sys.argv[2]).resolve()
source=pathlib.Path(__file__).resolve().parents[1];meta=json.loads((source/'patches/watchdog.json').read_text())
assert json.loads((root/'package.json').read_text())['version']==meta['version'],'Unsupported pi-subagents version; audit first'
p=root/meta['file'];s=p.read_text();marker='// minepi-watchdog-bridge-v1'
if s.startswith(marker+'\n'):
 lines=s.split('\n');assert lines[1].startswith('import { attachWatchdogBridge } from '),'Unknown bridge header';s='\n'.join(lines[2:]);s=s.replace('\n  attachWatchdogBridge(pi, mainWatchdog);','')
assert hashlib.sha256(s.encode()).hexdigest()==meta['pristineSha256'],'Package contents changed; patch refused'
needle='  const mainWatchdog = registerMainWatchdog(pi, { slashCommand: slashCommandsEnabled });';assert s.count(needle)==1
patched=f'{marker}\nimport {{ attachWatchdogBridge }} from {json.dumps(bridge.as_uri())};\n'+s.replace(needle,needle+'\n  attachWatchdogBridge(pi, mainWatchdog);')
if patched!=p.read_text():
 fd,name=tempfile.mkstemp(prefix=p.name+'.',dir=p.parent)
 try:
  with os.fdopen(fd,'w') as f:f.write(patched)
  os.chmod(name,p.stat().st_mode&0o777);os.replace(name,p)
 finally:
  if os.path.exists(name):os.unlink(name)
print('Watchdog bridge verified:',hashlib.sha256(patched.encode()).hexdigest())
