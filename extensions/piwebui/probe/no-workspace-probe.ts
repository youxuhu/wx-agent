/**
 * First launch must not pick a directory by itself.
 *
 * Without `--cwd` the service starts with *no* workspace (so the UI can ask), and it reopens the
 * folder that was active when it last stopped — but only if one was actually chosen before.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const agentDir = await mkdtemp(join(tmpdir(), "piwebui-noworkspace-"));
// The registry keys workspaces by realpath, and /var is /private/var on macOS.
const workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "piwebui-folder-")));

/** Start the service and resolve once it prints its machine-readable readiness line. */
function startService(): Promise<{ child: ReturnType<typeof spawn>; port: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["server/main.ts", "--port", "0", "--host", "127.0.0.1"], {
			cwd: process.cwd(),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("the service did not become ready")), 30_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += String(chunk);
			for (const line of buffer.split("\n")) {
				const match = /\{"type":"piwebui-ready".*"port":(\d+)/.exec(line);
				if (match) {
					clearTimeout(timer);
					resolve({ child, port: Number(match[1]) });
				}
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the service exited early (${String(code)})`));
		});
	});
}

type Socket = { socket: WebSocket; messages: Array<Record<string, unknown>> };
async function connect(port: number): Promise<Socket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages: Array<Record<string, unknown>> = [];
	socket.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	return { socket, messages };
}
const send = (client: Socket, message: Record<string, unknown>) => client.socket.send(JSON.stringify(message));
async function waitFor<T>(fn: () => T | Promise<T | undefined> | undefined, ms = 20_000): Promise<T | undefined> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== undefined) return value;
		await wait(150);
	}
	return undefined;
}

// ---- first run: nothing remembered ----
const first = await startService();
const client = await connect(first.port);
const hello = await waitFor(() => client.messages.find((m) => m.type === "hello"));
check("first run starts with no workspace", hello?.active === null, `active=${JSON.stringify(hello?.active)}`);
check("first run has no open workspace at all", Array.isArray(hello?.workspaces) && (hello?.workspaces as unknown[]).length === 0, JSON.stringify(hello?.workspaces));
check("no directory was auto-opened", hello?.cwd === null || hello?.cwd === undefined, `cwd=${JSON.stringify(hello?.cwd)}`);

const sessions = await fetch(`http://127.0.0.1:${first.port}/api/sessions`);
check("asking for sessions without a folder is refused, not guessed", sessions.status === 409, `HTTP ${sessions.status}`);

const before = client.messages.length;
send(client, { type: "prompt", message: "hello?" });
const refused = await waitFor(() => client.messages.slice(before).find((m) => m.type === "error"));
check(
	"a prompt without a folder is refused with a reason",
	typeof refused?.message === "string" && String(refused.message).includes("no workspace"),
	String(refused?.message),
);

// ---- the user picks a folder ----
send(client, { type: "open_workspace", path: workspaceDir });
const active = await waitFor(async () => {
	const updates = client.messages.filter((m) => m.type === "workspaces");
	const last = updates[updates.length - 1] as { active?: unknown } | undefined;
	return last?.active === workspaceDir ? last : undefined;
});
check("opening a folder makes it the active workspace", active?.active === workspaceDir, JSON.stringify(active?.active));

// ---- restart: the chosen folder is remembered, not invented ----
first.child.kill("SIGTERM");
await wait(1500);
const second = await startService();
const secondClient = await connect(second.port);
const secondHello = await waitFor(() => secondClient.messages.find((m) => m.type === "hello"));
check(
	"a restart reopens the folder that was chosen before",
	secondHello?.active === workspaceDir,
	`active=${JSON.stringify(secondHello?.active)}`,
);
second.child.kill("SIGTERM");
client.socket.close();
secondClient.socket.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
