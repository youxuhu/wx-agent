/**
 * `/login` in the browser.
 *
 * Measured facts this probe pins down (they are the reason the design is what it is):
 *  - `login` is NOT among `get_commands`, and sending `/login` as a prompt opens no dialog — the
 *    text reaches the model instead (measured against a live pi child). There is no
 *    non-interactive OAuth path to drive, so nothing here pretends to have one.
 *  - What the browser can honestly do: hand over a real terminal (the Shell drawer), type the
 *    command for the user, and let pi run the flow and write the credential itself.
 *
 * Usage: node probe/login-probe.ts [port]
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv[2] ?? 7796);
const base = join(homedir(), ".pi", "agent", "extensions", "piwebui");
const store = readFileSync(join(base, "web", "src", "stores", "session.ts"), "utf8");
const panel = readFileSync(join(base, "web", "src", "components", "SettingsPanel.vue"), "utf8");
const readme = readFileSync(join(base, "README.md"), "utf8");

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const messages: any[] = [];
socket.on("message", (raw: unknown) => messages.push(JSON.parse(String(raw))));
await new Promise((resolve) => socket.on("open", resolve));
await wait(2500);
const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
const records = (command: string) => messages.filter((m) => m.type === "record" && m.record?.command === command);

// 1. Why there is no dialog-driven path: the command simply is not there.
send({ type: "get_commands" });
await wait(2500);
const names: string[] = (records("get_commands").at(-1)?.record.data?.commands ?? []).map((c: any) => String(c.name));
check("pi lists extension commands, but no `login`", names.length > 0 && !names.includes("login"), `${names.length} commands: ${names.slice(0, 8).join(" ")}`);
check("`logout` is absent too (it is TUI-only as well)", !names.includes("logout"));

// 2. The handover really leaves the Enter key with the user: typed text is not executed.
send({ type: "pty_start", cols: 90, rows: 24 });
await wait(3000);
const typed = "echo login-$((6*7))";
send({ type: "pty_input", data: typed });
await wait(2500);
const screenAfterTyping = messages.filter((m) => m.type === "pty_data").map((m) => String(m.data)).join("");
check("the terminal echoed what was typed", screenAfterTyping.includes("echo login-"), screenAfterTyping.slice(-60));
check("nothing was executed by typing alone (the user still owns Enter)", !/login-42/.test(screenAfterTyping), /login-42/.test(screenAfterTyping) ? "the command ran without Enter" : "no result line");
send({ type: "pty_input", data: "\n" });
await wait(2500);
const screenAfterEnter = messages.filter((m) => m.type === "pty_data").map((m) => String(m.data)).join("");
check("pressing Enter is what runs it", /login-42/.test(screenAfterEnter), screenAfterEnter.slice(-60));

// 3. The client action only types `pi` — it never types a `/login <provider>` for the user, and it
//    does not touch credentials at all.
const action = store.slice(store.indexOf("startLoginTerminal()"), store.indexOf("startLoginTerminal()") + 900);
check("the client has a login-terminal action", action.length > 100);
check("it types `pi` and nothing else", /data: "pi"/.test(action), action.match(/data: "pi"/)?.[0]);
check("it never types the /login command for the user", !action.includes('data: "/login'));
check("it opens the terminal drawer", /this\.drawer = "shell"/.test(action));
check("the credentials page offers it", /startLoginTerminal\(\)/.test(panel));
check("the page states the measured limitation instead of implying OAuth works here", /does not exist in the RPC mode/.test(panel));

// 4. The README carries the same fact (no stale "/login has no equivalent" claim).
check("the README explains the terminal handover", /login/.test(readme) && /terminal/i.test(readme));

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
