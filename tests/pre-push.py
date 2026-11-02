import tempfile,pathlib,subprocess
script=pathlib.Path(__file__).resolve().parents[1]/'scripts/pre-push-check.py'
with tempfile.TemporaryDirectory(prefix='pi-push-test-') as t:
 p=pathlib.Path(t)
 def git(*args):return subprocess.check_output(['git',*args],cwd=t,stderr=subprocess.DEVNULL,text=True).strip()
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid')
 (p/'safe').write_text('safe');git('add','.');git('commit','-qm','safe');safe=git('rev-parse','HEAD')
 def check(commit):return subprocess.run(['python3',str(script)],cwd=t,input=f'refs/heads/main {commit} refs/heads/main '+('0'*40)+'\n',text=True,capture_output=True)
 assert check(safe).returncode==0
 (p/'bad').write_text('api_key="'+'sk-'+('x'*24)+'"');git('add','.');git('commit','-qm','unsafe');git('rm','bad');git('commit','-qm','remove');result=check(git('rev-parse','HEAD'));assert result.returncode!=0;assert 'x'*24 not in result.stderr
 print('PASS: clean push allowed, earlier secret commit caught even after deletion, no secret echo.')
