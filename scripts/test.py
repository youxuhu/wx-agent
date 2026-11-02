#!/usr/bin/env python3
import subprocess,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
for name in ['undo.test.mjs','conversation.mjs','native-session.mjs','footer.mjs','bridge.mjs','pdf.mjs','evidence.mjs','artifacts.mjs','light-runtime.mjs','plan-role.mjs']:
 print('RUN',name,flush=True);subprocess.run(['node',str(root/'tests'/name)],check=True,timeout=40)
subprocess.run(['python3',str(root/'tests/pre-push.py')],check=True,timeout=30)
print('All offline runtime checks passed.')
