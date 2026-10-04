/**
 * Deleting a session must be impossible outside this workspace's session directory, on anything
 * that is not a session file, and on the session that is currently open.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { deleteSession, sessionsDirFor } from "../server/sessions.ts";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const agentDir = await mkdtemp(join(tmpdir(), "piwebui-delagent-"));
const cwd = await realpath(await mkdtemp(join(tmpdir(), "piwebui-delws-")));
const dir = await sessionsDirFor(cwd, agentDir);
await mkdir(dir, { recursive: true });

const makeSession = async (name: string): Promise<string> => {
	const path = join(dir, name);
	await writeFile(path, `${JSON.stringify({ type: "header", cwd })}\n`, "utf8");
	return path;
};
const exists = async (path: string): Promise<boolean> =>
	stat(path).then(
		() => true,
		() => false,
	);

const doomed = await makeSession("2026-01-01T00-00-00-doomed.jsonl");
await deleteSession(cwd, agentDir, doomed, { current: null });
check("a session file in this workspace's directory is deleted", !(await exists(doomed)));

const outside = join(await realpath(tmpdir()), "piwebui-outside.jsonl");
await writeFile(outside, "{}\n", "utf8");
let outsideError = "";
await deleteSession(cwd, agentDir, outside, { current: null }).catch((error: unknown) => {
	outsideError = String(error);
});
check("a file outside the session directory is refused", outsideError.includes("refused") && (await exists(outside)), outsideError.slice(0, 70));

const notJsonl = join(dir, "notes.txt");
await writeFile(notJsonl, "x", "utf8");
let extError = "";
await deleteSession(cwd, agentDir, notJsonl, { current: null }).catch((error: unknown) => {
	extError = String(error);
});
check("a non-session file in that directory is refused", extError.includes("refused") && (await exists(notJsonl)), extError.slice(0, 70));

const traversal = `${dir}/../2026-01-01T00-00-00-escaped.jsonl`;
let traversalError = "";
await deleteSession(cwd, agentDir, traversal, { current: null }).catch((error: unknown) => {
	traversalError = String(error);
});
check("a traversal path out of the directory is refused", traversalError.includes("refused"), traversalError.slice(0, 70));

const open = await makeSession("2026-01-01T00-00-00-open.jsonl");
let openError = "";
await deleteSession(cwd, agentDir, open, { current: open }).catch((error: unknown) => {
	openError = String(error);
});
check("the session that is currently open is refused, with the reason", openError.includes("open") && (await exists(open)), openError.slice(0, 80));
check("...and it can be deleted once another session is open", await deleteSession(cwd, agentDir, open, { current: null }).then(() => true, () => false), "deleted after switching");

// ---- over the protocol: it must demand an explicit confirmation, then really delete ----
const wsAgentDir = await mkdtemp(join(tmpdir(), "piwebui-delwsagent-"));
const wsCwd = await realpath(await mkdtemp(join(tmpdir(), "piwebui-delwscwd-")));
const wsDir = await sessionsDirFor(wsCwd, wsAgentDir);
await mkdir(wsDir, { recursive: true });
const target = join(wsDir, "2026-01-02T00-00-00-protocol.jsonl");
await writeFile(target, `${JSON.stringify({ type: "header", cwd: wsCwd })}\n`, "utf8");

const child = spawn(process.execPath, ["server/main.ts", "--port", "0", "--host", "127.0.0.1", "--cwd", wsCwd], {
	cwd: process.cwd(),
	env: { ...process.env, PI_CODING_AGENT_DIR: wsAgentDir },
});
const port = await new Promise<number>((resolve, reject) => {
	let buffer = "";
	const timer = setTimeout(() => reject(new Error("service did not become ready")), 30_000);
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += String(chunk);
		const match = /\{"type":"piwebui-ready".*"port":(\d+)/.exec(buffer);
		if (match) {
			clearTimeout(timer);
			resolve(Number(match[1]));
		}
	});
});
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const messages: Array<Record<string, unknown>> = [];
socket.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
await new Promise((resolve, reject) => {
	socket.on("open", resolve);
	socket.on("error", reject);
});
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const waitFor = async <T>(fn: () => T | undefined, ms = 20_000): Promise<T | undefined> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = fn();
		if (value !== undefined) return value;
		await wait(150);
	}
	return undefined;
};

socket.send(JSON.stringify({ type: "delete_session", path: target }));
const unconfirmed = await waitFor(() => messages.find((m) => m.type === "error"));
check(
	"the protocol refuses a delete that was not confirmed",
	typeof unconfirmed?.message === "string" && String(unconfirmed.message).includes("confirmed"),
	String(unconfirmed?.message),
);
check("...and the file is still there", await exists(target));

socket.send(JSON.stringify({ type: "delete_session", path: target, confirmed: true }));
const deleted = await waitFor(() => messages.find((m) => m.type === "session_deleted"));
check("a confirmed delete reports the path it removed", deleted?.path === target, JSON.stringify(deleted?.path));
check("...and the file is gone", !(await exists(target)));
const refreshed = await waitFor(() => [...messages].reverse().find((m) => m.type === "sessions"));
const items = (refreshed?.items ?? []) as Array<{ path: string }>;
check("...and the session list is refreshed without it", Array.isArray(items) && !items.some((item) => item.path === target), `${items.length} session(s) left`);

child.kill("SIGTERM");
socket.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
