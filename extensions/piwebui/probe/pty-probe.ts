/**
 * The shell drawer is a real terminal.
 *
 * These checks exist because the previous implementation was not: `cd` could not survive (pi's
 * `bash` is stateless, one shell per call) and `clear` was executed as a command, which does
 * nothing without a terminal. A PTY fixes both, so both are asserted here.
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

const agentDir = await mkdtemp(join(tmpdir(), "piwebui-ptyagent-"));
const workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "piwebui-ptyws-")));
const otherDir = await realpath(await mkdtemp(join(tmpdir(), "piwebui-ptyother-")));

const child = spawn(process.execPath, ["server/main.ts", "--port", "0", "--host", "127.0.0.1", "--cwd", workspaceDir, "--no-remember"], {
	cwd: process.cwd(),
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
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
const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
const waitFor = async <T>(fn: () => T | undefined, ms = 20_000): Promise<T | undefined> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = fn();
		if (value !== undefined) return value;
		await wait(120);
	}
	return undefined;
};
/** Everything the terminal has been sent, with the escape sequences removed. */
const plain = (): string =>
	messages
		.filter((message) => message.type === "pty_data")
		.map((message) => String(message.data ?? ""))
		.join("")
		.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\u001b\][^\u0007]*\u0007/g, "");
const raw = (): string =>
	messages
		.filter((message) => message.type === "pty_data")
		.map((message) => String(message.data ?? ""))
		.join("");
const type = (data: string) => send({ type: "pty_input", data });

send({ type: "pty_start", cols: 100, rows: 30 });
const started = await waitFor(() => messages.find((message) => message.type === "pty_state"));
check("the terminal starts", started?.running === true, `shell=${String(started?.shell)} running=${String(started?.running)}`);
check("the terminal gets a real pty (size reported)", started?.cols === 100 && started?.rows === 30, `${String(started?.cols)}x${String(started?.rows)}`);
type("echo TERM=$TERM COLORTERM=$COLORTERM\r");
const termLine = await waitFor(() => (/TERM=xterm-256color/.test(plain()) ? true : undefined), 8000);
check(
	"the child believes it is on a terminal (that is what makes clear/colors work)",
	Boolean(termLine),
	/title: [^\n]*/.exec("") ? "" : (plain().match(/TERM=\S+[^\n]*/) ?? ["no TERM line"])[0],
);

const marker = `pty-probe-${Date.now()}`;
type(`echo ${marker}\r`);
const echoed = await waitFor(() => (plain().includes(marker) ? true : undefined));
check("typing runs the command", Boolean(echoed));

// The point of the whole exercise: a real shell keeps its state.
type("cd /tmp\r");
await wait(400);
type("pwd\r");
const changedDirectory = await waitFor(() => (/\/tmp\s/.test(plain()) ? true : undefined), 6000);
check("cd really persists inside the terminal", Boolean(changedDirectory), "pwd reports /tmp afterwards");

type("export PTY_PROBE_ENV=kept; echo ${PTY_PROBE_ENV}\r");
const exported = await waitFor(() => (plain().includes("kept") ? true : undefined), 6000);
check("export persists too (it is one process, not one per command)", Boolean(exported));

const before = raw().length;
type("clear\r");
await wait(700);
check("clear produces a real clear-screen sequence", /\u001b\[[0-9]*[JH]/.test(raw().slice(before)), "ESC[..J / ESC[..H seen");

type("echo still-alive-after-clear\r");
const afterClear = await waitFor(() => (plain().includes("still-alive-after-clear") ? true : undefined), 6000);
check("the shell still works after clear", Boolean(afterClear));

send({ type: "pty_resize", cols: 132, rows: 40 });
await wait(300);
type("echo resized\r");
const resized = await waitFor(() => (plain().includes("resized") ? true : undefined), 6000);
check("resizing the terminal does not break the shell", Boolean(resized));

// A second client (or a reopened drawer) reattaches to the same terminal and gets its history back.
const second = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const secondMessages: Array<Record<string, unknown>> = [];
second.on("message", (raw2) => secondMessages.push(JSON.parse(String(raw2)) as Record<string, unknown>));
await new Promise((resolve, reject) => {
	second.on("open", resolve);
	second.on("error", reject);
});
second.send(JSON.stringify({ type: "pty_start", cols: 100, rows: 30 }));
const replayed = await waitFor(() => secondMessages.find((message) => message.type === "pty_state"));
check("reattaching reuses the running terminal", replayed?.running === true, `running=${String(replayed?.running)}`);
check(
	"...and replays the recent output instead of a blank window",
	String(replayed?.replay ?? "").includes(marker),
	`${String(replayed?.replay ?? "").length} chars replayed`,
);

// Typing into a workspace that is not active is a write, and writes belong to the active one.
second.send(JSON.stringify({ type: "open_workspace", path: otherDir, activate: false }));
await waitFor(() => secondMessages.find((message) => message.type === "workspaces" && message.active === workspaceDir));
second.send(JSON.stringify({ type: "pty_input", workspace: otherDir, data: "echo should-not-run\r" }));
const refused = await waitFor(() => secondMessages.find((message) => message.type === "error"));
check(
	"typing into a non-active workspace is refused (one writer at a time)",
	typeof refused?.message === "string",
	String(refused?.message).slice(0, 60),
);

// The drawer's Restart button sends kill+start back to back. The killed shell exits *asynchronously*,
// so its exit callback must not touch the terminal that replaced it: an unguarded callback detached
// the new shell (typing stopped working) and, worse, threw inside the socket handler.
send({ type: "pty_kill" });
send({ type: "pty_start", cols: 100, rows: 30 });
await wait(1500);
const afterRestart = messages.filter((message) => message.type === "pty_state").at(-1);
check("restarting the terminal leaves a running terminal", afterRestart?.running === true, `running=${String(afterRestart?.running)}`);
// The marker is *built by the shell*, so the typed text can never match it. That matters: zsh's line
// editor redraws the prompt with "\r \r" and erases its own echo, so an assertion on "echo + output
// = two occurrences" failed while the terminal was working perfectly well.
const restartStarted = Date.now();
type("echo restart-$((1 + 1))-marker\r");
const restartedAfterMs = await waitFor(() => (plain().includes("restart-2-marker") ? Date.now() - restartStarted : undefined), 15_000);
check("typing works after a restart", restartedAfterMs !== undefined, `${restartedAfterMs === undefined ? "never" : String(restartedAfterMs)}ms after the restart`);

// Hammering it is the honest test: a stale callback can survive one restart and fail on the third.
for (let round = 0; round < 3; round += 1) {
	send({ type: "pty_kill" });
	send({ type: "pty_start", cols: 100, rows: 30 });
	await wait(700);
}
type("echo survived-$((40 + 2))-restarts\r");
const survived = await waitFor(() => (plain().includes("survived-42-restarts") ? true : undefined), 15_000);
check("the terminal still works after repeated restarts", Boolean(survived));

// And the service itself must be alive: a throw in a socket handler used to take down the process.
const alive = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true).catch(() => false);
check("the service survives the restart sequence (a throw here used to kill it)", alive);

// Asking for a kill is answered with state, not with an "it exited" notice nobody needs.
send({ type: "pty_kill" });
const killed = await waitFor(() => (messages.filter((message) => message.type === "pty_state").at(-1)?.running === false ? true : undefined), 6000);
check("killing the terminal reports it as not running", Boolean(killed));

// A shell that dies on its own is different: that one is an event the UI must tell the user about.
send({ type: "pty_start", cols: 100, rows: 30 });
await waitFor(() => (messages.filter((message) => message.type === "pty_state").at(-1)?.running === true ? true : undefined), 6000);
await wait(500);
type("exit\r");
const exited = await waitFor(() => messages.find((message) => message.type === "pty_exit"), 8000);
check("a shell that exits on its own is reported as an exit", exited !== undefined, `exitCode=${String(exited?.exitCode)}`);

child.kill("SIGTERM");
socket.close();
second.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
