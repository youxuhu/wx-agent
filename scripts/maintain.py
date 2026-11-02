#!/usr/bin/env python3
"""Local runtime source of truth: install, verify, guarded rollback, read-only update preview."""
import argparse,pathlib,json,hashlib,shutil,tempfile,os,subprocess,datetime,urllib.request,urllib.parse,concurrent.futures,contextlib
SOURCE=pathlib.Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def atomic(p,data,mode=0o600):
 p.parent.mkdir(parents=True,exist_ok=True);fd,name=tempfile.mkstemp(prefix=p.name+'.',dir=p.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  os.chmod(name,mode);os.replace(name,p)
 finally:
  if os.path.exists(name):os.unlink(name)
def load(p):return json.loads(p.read_text())
def files():
 excluded={'node_modules','__pycache__','.git','dist','build','target','piwebui'}
 return [p for p in (SOURCE/'extensions').rglob('*') if p.is_file() and not excluded.intersection(p.relative_to(SOURCE/'extensions').parts)]
def core_dir():
 explicit=os.environ.get('PI_CORE_DIR')
 candidates=[pathlib.Path(explicit)] if explicit else []
 executable=shutil.which('pi')
 if executable:candidates.extend(pathlib.Path(executable).resolve().parents)
 for p in candidates:
  try:
   if load(p/'package.json').get('name')=='@earendil-works/pi-coding-agent':return p
  except (OSError,ValueError):pass
 raise RuntimeError('Cannot resolve Pi package; set PI_CORE_DIR to its package directory')
@contextlib.contextmanager
def deployment_lock(root):
 key=hashlib.sha256(str(root.resolve()).encode()).hexdigest()
 directory=pathlib.Path(tempfile.gettempdir())/('pi-maintenance-'+str(getattr(os,'getuid',lambda:0)()))
 directory.mkdir(mode=0o700,exist_ok=True)
 with (directory/key).open('a+b') as handle:
  try:
   if os.name=='nt':
    import msvcrt
    handle.seek(0);handle.write(b'0');handle.flush();handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
   else:
    import fcntl
    fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except OSError:raise RuntimeError('Another deployment or rollback is running for this directory')
  try:yield
  finally:
   if os.name=='nt':handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
   else:fcntl.flock(handle,fcntl.LOCK_UN)
def preflight(root,xdg,expected):
 errors=[];core=None;peers={};node=None
 try:
  core=core_dir()
  if load(core/'package.json')['version']!='1.4.0':errors.append('Pi 1.4.0 required; audit another version before installing')
  for name in ['pi-ai','pi-tui','pi-agent-core']:
   peers[name]=load(core/'node_modules/@earendil-works'/name/'package.json')['version']
   if peers[name]!='1.4.0':errors.append('Unsupported SDK peer: '+name)
 except Exception as e:errors.append(str(e))
 for name in ['node','git']:
  if not shutil.which(name):errors.append('Missing executable: '+name)
 if shutil.which('node'):
  node=subprocess.check_output(['node','--version'],text=True).strip()
  if int(node.lstrip('v').split('.')[0])<22:errors.append('Node >=22 required')
 try:
  npm=load(root/'npm/package-lock.json').get('packages',{})
  for spec in expected['packages']:
   name,version=spec[4:].rsplit('@',1)
   try:
    if load(root/'npm/node_modules'/name/'package.json')['version']!=version:errors.append('Package version mismatch: '+name)
    if not npm.get('node_modules/'+name,{}).get('integrity'):errors.append('Missing npm integrity: '+name)
   except Exception:errors.append('Missing package: '+name)
 except Exception:errors.append('Missing or invalid npm/package-lock.json')
 try:load(root/'settings.json')
 except Exception:errors.append('Missing or invalid target settings.json')
 for target in [root,xdg,SOURCE/'backups']:
  parent=target
  while not parent.exists():parent=parent.parent
  if not parent.is_dir() or not os.access(parent,os.W_OK):errors.append('Directory not writable: '+str(target))
 # An existing target configuration is a machine-local override; preserve it.
 lsp=root/'pi-lsp.json'
 try:
  config=load(lsp if lsp.exists() else SOURCE/'config/pi-lsp.json')
  for name,record in config.items():
   command=record.get('command',[])
   if not command or not shutil.which(command[0]):errors.append('LSP executable unavailable: '+name)
   for item in command[1:]:
    if item.endswith(('.mjs','.js','.cjs')) and not pathlib.Path(item).is_file():errors.append('LSP entry missing: '+item)
   path=record.get('initialization',{}).get('tsserver',{}).get('path')
   if path and not pathlib.Path(path).is_file():errors.append('tsserver missing: '+path)
 except Exception as e:errors.append('Invalid LSP configuration: '+str(e))
 if errors:raise RuntimeError('Preflight failed:\n- '+'\n- '.join(errors))
 return core,peers,node
def verify(root):
 lock=load(root/'maintenance-lock.json');issues=[]
 core=core_dir()
 if subprocess.check_output(['node','--version'],text=True).strip()!=lock['node']:issues.append('Node version changed; compatibility needs verification')
 if load(core/'package.json')['version']!=lock['pi']:issues.append('Pi core version changed; compatibility needs verification')
 for name,version in lock.get('peers',{}).items():
  if load(core/'node_modules/@earendil-works'/name/'package.json')['version']!=version:issues.append('SDK peer changed: '+name)
 for rel,expected in lock['files'].items():
  p=root/rel
  if not p.exists() or sha(p)!=expected:issues.append('file drift: '+rel)
 for path,expected in lock.get('externalFiles',{}).items():
  p=pathlib.Path(path)
  if not p.exists() or sha(p)!=expected:issues.append('guidance config drift: '+path)
 for name,record in lock['packages'].items():
  p=root/'npm/node_modules'/name/'package.json'
  if not p.exists() or load(p)['version']!=record['version']:issues.append('package mismatch: '+name)
 for rel,expected in lock['patches'].items():
  if not (root/rel).exists() or sha(root/rel)!=expected:issues.append('patch drift: '+rel)
 settings=load(root/'settings.json');expected=lock['settings']
 for key in ['packages','defaultTools','codemode']:
  if settings.get(key)!=expected.get(key):issues.append('settings drift: '+key)
 if settings.get('subagents',{}).get('watchdog',{}).get('lsp')!={'enabled':False}:issues.append('watchdog LSP pre-pass is not disabled')
 print(json.dumps({'ok':not issues,'issues':issues,'packages':{k:v['version'] for k,v in lock['packages'].items()}},indent=2));return not issues
def install(root,xdg):
 expected=load(SOURCE/'config/settings.json');core,peers,node=preflight(root,xdg,expected);meta=load(SOURCE/'patches/watchdog.json');package=root/'npm/node_modules/pi-subagents';assert load(package/'package.json')['version']==meta['version']
 # Preflight source patch in a disposable package before touching the runtime.
 with tempfile.TemporaryDirectory(prefix='pi-patch-preflight-') as t:
  p=pathlib.Path(t);(p/'bundle').mkdir();shutil.copy2(package/'package.json',p/'package.json');shutil.copy2(package/meta['file'],p/meta['file'])
  subprocess.run(['python3',str(SOURCE/'scripts/patch-watchdog.py'),str(p),str(root/'extensions/runtime-support/watchdog-bridge.mjs')],check=True,capture_output=True)
 settings=load(root/'settings.json');settings.update({k:expected[k] for k in ['packages','defaultTools','codemode']});settings.setdefault('subagents',{}).setdefault('watchdog',{})['lsp']={'enabled':False}
 # Lens files are retained on disk, but only the pinned configured packages are active.
 for spec in settings['packages']:
  name,version=spec[4:].rsplit('@',1);assert load(root/'npm/node_modules'/name/'package.json')['version']==version,'Package missing or mismatched: '+name
 targets={root/p.relative_to(SOURCE):p.read_bytes() for p in files()}
 for name in ['maintain.py','patch-watchdog.py','pre-push-check.py']:targets[root/'scripts'/name]=(SOURCE/'scripts'/name).read_bytes()
 targets[root/'patches/watchdog.json']=(SOURCE/'patches/watchdog.json').read_bytes()
 targets[root/'settings.json']=(json.dumps(settings,ensure_ascii=False,indent=2)+'\n').encode()
 targets[root/'pi-lsp.json']=(root/'pi-lsp.json').read_bytes() if (root/'pi-lsp.json').exists() else (SOURCE/'config/pi-lsp.json').read_bytes()
 for name in ['rpiv-todo','rpiv-ask-user-question']:
  p=xdg/name/'config.json';d=load(p) if p.exists() else {};d.update(load(SOURCE/'config'/f'{name}.json'));targets[p]=(json.dumps(d,indent=2)+'\n').encode()
 gitignore=root/'.gitignore';text=gitignore.read_text() if gitignore.exists() else ''
 for entry in ['outputs/','handoffs/','maintenance-candidates.json','maintenance-lock.json','backups/','__pycache__/','/pi-lsp.json']:
  if entry not in text.splitlines():text+='\n'+entry+'\n'
 targets[gitignore]=text.encode()
 current=root/'maintenance-lock.json'
 if current.exists() and all(p.exists() and p.read_bytes()==data for p,data in targets.items()) and verify(root):print('Already installed; no changes.');return
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ');backup=SOURCE/'backups'/stamp;backup.mkdir(parents=True,mode=0o700);records=[]
 def backup_file(p):
  dest=backup/str(len(records));record={'target':str(p),'backup':str(dest) if p.exists() else None,'mode':(p.stat().st_mode&0o777) if p.exists() else 0o600}
  if p.exists():
   shutil.copy2(p,dest);dest.chmod(0o600)
  records.append(record)
 for p in list(targets)+[package/meta['file'],current]:backup_file(p)
 try:
  for p,data in targets.items():atomic(p,data,p.stat().st_mode&0o777 if p.exists() else 0o600)
  subprocess.run(['python3',str(SOURCE/'scripts/patch-watchdog.py'),str(package),str(root/'extensions/runtime-support/watchdog-bridge.mjs')],check=True)
  npmlock=load(root/'npm/package-lock.json').get('packages',{});packages={}
  for spec in settings['packages']:
   name,version=spec[4:].rsplit('@',1);record=npmlock.get('node_modules/'+name,{});packages[name]={'version':version,'integrity':record.get('integrity'),'source':load(root/'npm/node_modules'/name/'package.json').get('repository')}

  lock={'version':1,'recordedAt':stamp,'pi':load(core/'package.json')['version'],'peers':peers,'node':node,'source':str(SOURCE),'files':{str(p.relative_to(root)):sha(p) for p in targets if p.is_relative_to(root) and p not in [root/'settings.json',root/'.gitignore']},'packages':packages,'externalFiles':{str(p):sha(p) for p in targets if not p.is_relative_to(root)},'settings':{k:settings[k] for k in ['packages','defaultTools','codemode']},'patches':{str((package/meta['file']).relative_to(root)):sha(package/meta['file'])}}
  atomic(current,(json.dumps(lock,ensure_ascii=False,indent=2)+'\n').encode())
  for row in records:row['installedHash']=sha(pathlib.Path(row['target'])) if pathlib.Path(row['target']).exists() else None
  atomic(backup/'rollback.json',(json.dumps(records,indent=2)+'\n').encode());print('Installed. Rollback:',backup/'rollback.json');assert verify(root)
 except BaseException:
  for row in reversed(records):
   p=pathlib.Path(row['target'])
   if row['backup']:atomic(p,pathlib.Path(row['backup']).read_bytes(),row['mode'])
   else:p.unlink(missing_ok=True)
  raise

def rollback(path):
 records=load(path)
 for row in records:
  p=pathlib.Path(row['target']);assert p.exists() and sha(p)==row['installedHash'],'Rollback stopped: later change to '+str(p)
 for row in reversed(records):
  p=pathlib.Path(row['target'])
  if row['backup']:atomic(p,pathlib.Path(row['backup']).read_bytes(),row['mode'])
  else:p.unlink(missing_ok=True)
 print('Rollback complete; no later edits overwritten.')
def updates(root):
 lock=load(root/'maintenance-lock.json')
 def check(item):
  name,record=item
  try:
   url='https://registry.npmjs.org/'+urllib.parse.quote(name,safe='')+'/latest'
   with urllib.request.urlopen(url,timeout=12) as r:d=json.load(r)
   return {'name':name,'installed':record['version'],'available':d['version'],'status':'current' if d['version']==record['version'] else 'candidate (not tested)','integrity':d.get('dist',{}).get('integrity')}
  except Exception as e:return {'name':name,'installed':record['version'],'status':'unavailable','error':type(e).__name__}
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(check,lock['packages'].items()))
 atomic(root/'maintenance-candidates.json',(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'packages':rows},indent=2)+'\n').encode());print(json.dumps(rows,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['install','verify','rollback','update-check']);p.add_argument('--root',type=pathlib.Path,default=pathlib.Path.home()/'.pi/agent');p.add_argument('--xdg',type=pathlib.Path,default=pathlib.Path(os.environ.get('XDG_CONFIG_HOME',str(pathlib.Path.home()/'.config'))));p.add_argument('--backup',type=pathlib.Path);args=p.parse_args()
 if args.action=='install':
  with deployment_lock(args.root):install(args.root.resolve(),args.xdg.resolve())
 elif args.action=='verify':sys_ok=verify(args.root);raise SystemExit(0 if sys_ok else 1)
 elif args.action=='rollback':
  if not args.backup:raise SystemExit('--backup required')
  records=load(args.backup);settings=[pathlib.Path(r['target']).parent for r in records if pathlib.Path(r['target']).name=='settings.json']
  if len(settings)!=1:raise SystemExit('Ambiguous rollback root')
  with deployment_lock(settings[0]):rollback(args.backup)
 else:updates(args.root)
