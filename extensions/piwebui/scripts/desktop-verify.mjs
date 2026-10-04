/**
 * Verify the staged desktop runtime *before* packaging: it must be able to start pi in RPC mode
 * with the curated node_modules subset (extensions load through jiti) and answer a command.
 * Usage: node scripts/desktop-verify.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "desktop", "resources");
const node = join(resources, "node");
const server = join(resources, "server.mjs");

const child = spawn(node, [server, "--port", "0", "--host", "127.0.0.1", "--cwd", process.env.HOME ?? "/tmp", "--pi-node", node, "--pi-script", join(resources, "pi/dist/bundle/cli.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent` },
});

let port = null;
const errors = [];
child.stdout.on("data", (chunk) => {
	for (const line of chunk.toString("utf8").split("\n")) {
		if (line.includes("piwebui-ready")) {
			try {
				port = JSON.parse(line).port;
			} catch {
				/* ignore */
			}
		}
	}
});
child.stderr.on("data", (chunk) => errors.push(chunk.toString("utf8").slice(0, 400)));

const deadline = Date.now() + 30_000;
while (!port && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

if (!port) {
	console.log("FAIL  staged runtime never reported a port", errors.join(" | ").slice(0, 400));
	child.kill();
	process.exit(1);
}

const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
const extensionErrors = errors.join("\n").match(/Failed to load extension[^\n]*/g) ?? [];
console.log(`port ${port} · workspaces ${health.workspaces?.length} · state ${health.workspaces?.[0]?.state}`);
if (extensionErrors.length) console.log(`FAIL  ${extensionErrors.length} extension(s) failed to load:\n  ${extensionErrors.slice(0, 3).join("\n  ")}`);
else console.log("PASS  extensions loaded from the curated runtime");

// The terminal is a native addon: prove it loads *and spawns* under the bundled node, which is the
// part a plain `npm install` on the build machine does not prove.
spawn(node, ["-e", `const pty=require(${JSON.stringify(join(resources, "node_modules/node-pty"))});const t=pty.spawn("/bin/sh",["-c","echo pty-verify-ok"],{name:"xterm-256color",cols:80,rows:24,cwd:process.cwd()});let out="";t.onData((d)=>{out+=d});setTimeout(()=>{const ok=out.includes("pty-verify-ok");console.log(ok?"PTY-OK":"PTY-FAIL:"+JSON.stringify(out));process.exit(ok?0:1)},2500);`], {
	stdio: "inherit",
}).on("exit", (code) => {
	if (code !== 0) console.error("FAIL  the bundled node cannot spawn a pty");
});
child.kill();
process.exit(extensionErrors.length ? 1 : 0);
