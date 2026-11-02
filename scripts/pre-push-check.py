#!/usr/bin/env python3
"""Check every outgoing commit; report no secret content. Called by Git pre-push."""
import sys,re,subprocess
patterns=[r'sk-[A-Za-z0-9_-]{16,}',r'Bearer [A-Za-z0-9._-]{16,}',r'-----BEGIN [A-Z ]*PRIVATE KEY-----',r'AKIA[0-9A-Z]{16}',r'gh[pousr]_[A-Za-z0-9]{20,}',r'xox[baprs]-[A-Za-z0-9-]{10,}',r'(?i)(?:api[_-]?key|token|secret)[\"\x27]?\s*[:=]\s*[\"\x27][A-Za-z0-9_.-]{16,}[\"\x27]']
def git(*args):return subprocess.check_output(['git',*args],stderr=subprocess.DEVNULL,text=True)
try:
 for line in sys.stdin:
  localref,local,remoteref,remote=line.split()
  if set(local)=={'0'}:continue
  revisions=[local]
  if set(remote)!={'0'}:revisions.append('^'+remote)
  else:revisions+=['--not','--remotes']
  for commit in git('rev-list',*revisions).splitlines():
   for added in git('show','--format=','--root','--no-ext-diff',commit).splitlines():
    if not added.startswith('+') or added.startswith('+++'):continue
    if any(re.search(p,added) for p in patterns):raise ValueError('Possible credential in an outgoing commit')
  files=git('ls-tree','-r','--name-only',local).splitlines()
  if any(re.search(r'(^|/)(auth\.json|web-search\.json|\.env|\.git-credentials)$',p) for p in files):raise ValueError('Credential file tracked by outgoing revision')
except Exception as e:
 print('pre-push: BLOCKED; '+(str(e) if isinstance(e,ValueError) else 'could not verify outgoing history'),file=sys.stderr);sys.exit(1)
