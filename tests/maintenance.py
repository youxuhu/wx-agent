import pathlib,tempfile,shutil,json,subprocess,hashlib
source=pathlib.Path(__file__).resolve().parents[1];real=pathlib.Path('/home/revy/.pi/agent')
with tempfile.TemporaryDirectory(prefix='pi-maintain-test-') as t:
 root=pathlib.Path(t)/'agent';root.mkdir();xdg=pathlib.Path(t)/'xdg';(root/'npm/node_modules/pi-subagents').mkdir(parents=True)
 shutil.copytree(real/'npm/node_modules/pi-subagents',root/'npm/node_modules/pi-subagents',dirs_exist_ok=True)
 settings=json.loads((real/'settings.json').read_text());original=json.dumps(settings).encode();(root/'settings.json').write_bytes(original)
 shutil.copy2(real/'npm/package-lock.json',root/'npm/package-lock.json')
 for spec in json.loads((source/'config/settings.json').read_text())['packages']:
  name,version=spec[4:].rsplit('@',1);p=root/'npm/node_modules'/name
  if name=='pi-subagents':continue
  p.parent.mkdir(parents=True,exist_ok=True);p.symlink_to(real/'npm/node_modules'/name,target_is_directory=True)
 def run(action,check=True,*extra):return subprocess.run(['python3',str(source/'scripts/maintain.py'),action,'--root',str(root),'--xdg',str(xdg),*extra],capture_output=True,text=True,check=check)
 first=run('install');lock=(root/'maintenance-lock.json').read_bytes();again=run('install');assert 'Already installed' in again.stdout;assert (root/'maintenance-lock.json').read_bytes()==lock
 assert run('verify').returncode==0
 # Unknown changed bundle cannot be silently accepted as a compatible patch.
 p=root/'npm/node_modules/pi-subagents/bundle/chunk-235AWJUQ.js';good=p.read_bytes();p.write_bytes(good+b'\n// unverified candidate\n');assert run('verify',False).returncode!=0;assert run('install',False).returncode!=0;p.write_bytes(good)
 manifest=next(line.split('Rollback: ',1)[1] for line in first.stdout.splitlines() if 'Rollback: ' in line)
 managed=root/'extensions/tool-awareness/index.ts';good=managed.read_bytes();managed.write_bytes(good+b'\n// later user edit\n');assert run('rollback',False,'--backup',manifest).returncode!=0;managed.write_bytes(good)
 run('rollback',True,'--backup',manifest);assert (root/'settings.json').read_bytes()==original;assert not (root/'maintenance-lock.json').exists()
 print('PASS: isolated install/verify, idempotent re-install, candidate drift refusal, conflict-aware rollback, original settings restored.')
