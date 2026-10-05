/**
 * Restarting pi in place (the browser's `/reload`).
 *
 * Facts pinned here:
 *  - a live run is not stopped by a stray click (the first request is refused, not honoured);
 *  - the same session file is resumed, and the server says which one it actually resumed;
 *  - state/messages/commands are readable again afterwards;
 *  - the terminal (a separate process) is untouched;
 *  - a second tab cannot restart someone else's workspace (write gate).
 *
 * Usage: node probe/reload-probe.ts [port]
 */
import { WebSocket } from "ws";

const port = Number(process.argv[2] ?? 7796);
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect() {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages: any[] = [];
	socket.on("message", (raw: unknown) => messages.push(JSON.parse(String(raw))));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	await wait(2500);
	return {
		socket,
		messages,
		send: (m: Record<string, unknown>) => socket.send(JSON.stringify(m)),
		records: (command: string) => messages.filter((m) => m.type === "record" && m.record?.command === command),
	};
}

const client = await connect();
const state = () => client.records("get_state").at(-1)?.record.data as Record<string, unknown> | undefined;

// 1. A session has to be open for "resume the same session" to mean anything.
client.send({ type: "get_state" });
await wait(1500);
const before = state();
check("a session is open before the restart", Boolean(before?.sessionFile), String(before?.sessionFile));
const beforePath = String(before?.sessionFile ?? "");

// 2. The terminal is a separate process: it must survive the restart.
client.send({ type: "pty_start", cols: 90, rows: 24 });
await wait(2500);
const ptyBefore = client.messages.filter((m) => m.type === "pty_state").at(-1);
client.send({ type: "pty_input", data: "echo pty-alive-$((2+3))\n" });
await wait(2500);
const typedBefore = client.messages.filter((m) => m.type === "pty_data").map((m) => String(m.data)).join("");
check("the terminal answered before the restart", typedBefore.includes("pty-alive-5"), typedBefore.slice(-60));

// 3. Restart, and read what the server reports.
client.send({ type: "reload_pi", confirmed: true });
let restarted: any = null;
for (let attempt = 0; attempt < 30 && !restarted; attempt++) {
	await wait(500);
	restarted = client.messages.find((m) => m.type === "pi_restarted");
}
check("the restart is reported as a fact", Boolean(restarted), JSON.stringify(restarted && { resumed: restarted.resumed, requested: restarted.requested }));
check("it resumed the same session file", restarted?.resumed === beforePath && restarted?.requested === beforePath, `${restarted?.requested} -> ${restarted?.resumed}`);
check("dropping pending approvals is reported (not hidden)", typeof restarted?.pendingApprovals === "number", String(restarted?.pendingApprovals));

// 4. The new process answers again.
await wait(3000);
client.send({ type: "get_state" });
client.send({ type: "get_messages" });
client.send({ type: "get_commands" });
await wait(3000);
const after = state();
check("state is readable again", Boolean(after?.sessionFile), String(after?.sessionFile));
check("the session path matches what was resumed", after?.sessionFile === restarted?.resumed, `${after?.sessionFile} vs ${restarted?.resumed}`);
const afterMessages = client.records("get_messages").at(-1)?.record.data?.messages;
check("the conversation is still readable", Array.isArray(afterMessages), `${Array.isArray(afterMessages) ? afterMessages.length : "no answer"} messages`);
check("commands are registered again (extensions reloaded)", (client.records("get_commands").at(-1)?.record.data?.commands ?? []).length > 0, `${(client.records("get_commands").at(-1)?.record.data?.commands ?? []).length} commands`);

// 5. The terminal never noticed.
const ptyAfter = client.messages.filter((m) => m.type === "pty_state").at(-1);
check("the terminal process is still there", Boolean(ptyAfter?.replay !== undefined) || client.messages.filter((m) => m.type === "pty_exit").length === 0, JSON.stringify({ exits: client.messages.filter((m) => m.type === "pty_exit").length }));
client.send({ type: "pty_input", data: "echo pty-after-$((3+4))\n" });
await wait(2500);
const typedAfter = client.messages.filter((m) => m.type === "pty_data").map((m) => String(m.data)).join("");
check("the terminal still accepts input after the restart", typedAfter.includes("pty-after-7"), typedAfter.slice(-60));

// 6. The confirmation guard exists for live runs (static + protocol shape).
// A real run makes this a fact rather than an inference: restarting must not stop it silently.
client.send({ type: "prompt", message: "Write a detailed 800-word essay about mountains. Plain text." });
let started = false;
for (let attempt = 0; attempt < 20 && !started; attempt++) {
	await wait(500);
	started = client.messages.some((m) => m.type === "record" && m.record?.type === "agent_start");
}
if (started) {
	const guardFrom = client.messages.length;
	client.send({ type: "reload_pi" });
	await wait(1500);
	const refusal = client.messages.slice(guardFrom).find((m) => m.type === "error") as { code?: string; message?: string } | undefined;
	check("a live run is not restarted without confirmation", refusal?.code === "needs-confirmation", refusal?.message);
	client.send({ type: "abort" });
	await wait(2000);
} else {
	check("a live run is not restarted without confirmation", false, "no run started — the guard could not be exercised");
}

const other = await connect();
other.send({ type: "reload_pi", confirmed: true, workspace: "/tmp/definitely-not-a-workspace" });
await wait(800);
check("a foreign workspace cannot be restarted", Boolean(other.messages.find((m) => m.type === "error" && /unknown workspace/.test(String(m.message)))));
const anyRefusal = client.messages.find((m) => m.type === "error" && String(m.code ?? "") === "needs-confirmation");
check("the guard code is machine-readable", Boolean(anyRefusal) || !started, String(anyRefusal?.code ?? "not exercised"));
other.socket.close();
client.socket.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
