const pty = require("node-pty");
const shell = pty.spawn("/bin/bash", ["-l"], {
  name: "xterm-256color", cols: 100, rows: 30,
  cwd: process.env.HOME,
  env: { ...process.env, TERM: "xterm-256color" },
});
let raw = "";
shell.onData((d) => { raw += d; });
const send = (s) => shell.write(s + "\r");
setTimeout(() => send("echo PTY-OK; cd /tmp; pwd"), 600);
setTimeout(() => send("clear; echo after-clear"), 1600);
setTimeout(() => {
  const plain = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\u0007]*\u0007/g, "");
  console.log("PTY 收到输出:", raw.length > 0, "字节数:", raw.length);
  console.log("命令执行了 (PTY-OK):", plain.includes("PTY-OK"));
  console.log("cd 持久 (pwd=/tmp):", /\/tmp/.test(plain));
  console.log("clear 发出清屏序列:", /\x1b\[[0-9]*[JH]/.test(raw) || /\x1b\[3J/.test(raw));
  console.log("clear 之后还能继续跑:", plain.includes("after-clear"));
  shell.kill();
  process.exit(0);
}, 2600);
