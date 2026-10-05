/**
 * Code checkpoints and rewind.
 *
 * Facts pinned here:
 *  - the listing is read from the checkpoint extension's own index, filtered by the workspace's
 *    git top level, and numbered exactly like the extension (`#1` = newest of the last 15);
 *  - a rewind is only ever the extension's own command (`/rewind <n>`), never a ref or a git call;
 *  - an unknown index is refused instead of guessed;
 *  - the extension asks for its own confirmation, which reaches the client as a dialog;
 *  - a live run blocks a rewind.
 *
 * Usage: node probe/rewind-probe.ts [port] [--agent-dir <dir>]
 */
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const port = Number(args.find((value) => /^\d+$/.test(value)) ?? 7796);
const agentDirIndex = args.indexOf("--agent-dir");
const agentDir = agentDirIndex >= 0 ? args[agentDirIndex + 1] : "/tmp/scrolllab-agent";
// The extension keys its index by the git top level it sees, which is always a realpath
// (/tmp is a symlink to /private/tmp on macOS) — the fixture must use the same spelling.
const repo = realpathSync("/tmp/cplab");

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fixture: the extension's index with this repo's snapshots plus a foreign repo's (which must not show).
const entries = [
	{ repo: "/somewhere/else", ref: "ffffffffffffffffffffffffffffffffffffffff", at: "2026-01-01T00:00:00.000Z", files: ["other.txt"], kind: "dirty" },
	...Array.from({ length: 17 }, (_, i) => ({
		repo,
		ref: `${String(i + 1).padStart(4, "0")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 40),
		at: `2026-10-05T10:${String(i).padStart(2, "0")}:00.000Z`,
		entryId: `entry-${i + 1}`,
		files: [`file-${i + 1}.txt`],
		kind: "dirty" as const,
	})),
];
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "checkpoints.json"), JSON.stringify(entries, null, 2));

async function connect() {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages: any[] = [];
	socket.on("message", (raw: unknown) => messages.push(JSON.parse(String(raw))));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	await wait(2500);
	return { socket, messages, send: (m: Record<string, unknown>) => socket.send(JSON.stringify(m)) };
}

const client = await connect();

// 1. The listing: this repo only, newest first, same window as the extension.
const listing = await fetch(`http://127.0.0.1:${port}/api/checkpoints`).then((r) => r.json());
check("the listing resolves the workspace's git top level", listing.repo === repo || listing.repo?.endsWith("/cplab"), String(listing.repo));
check("another repository's snapshots are not listed", (listing.rows ?? []).every((row: any) => row.ref !== "ffffffffffffffffffffffffffffffffffffffff"));
check("the window matches the extension's (15)", listing.window === 15 && listing.rows.length === 15, `${listing.rows.length} rows, window ${listing.window}`);
check("#1 is the newest snapshot", listing.rows[0]?.at === "2026-10-05T10:16:00.000Z", String(listing.rows[0]?.at));
check("rows keep the extension's numbering", listing.rows[14]?.index === 15, String(listing.rows[14]?.index));

// 2. An index that is not in the listing is refused (no guessing, no arbitrary refs).
const badFrom = client.messages.length;
client.send({ type: "rewind", index: 99 });
await wait(1200);
const bad = client.messages.slice(badFrom).find((m) => m.type === "error");
check("an index outside the window is refused", /1\.\.15/.test(String(bad?.message)), bad?.message);
client.send({ type: "rewind", index: 0 });
await wait(1000);
check("index 0 is refused", client.messages.slice(badFrom).some((m) => m.type === "error" && /1\.\.15/.test(String(m.message))));

// 3. A valid rewind is forwarded as the extension's own command.
const before = client.messages.length;
client.send({ type: "rewind", index: 3 });
await wait(2000);
const sent = client.messages.slice(before).find((m) => m.type === "rewind_sent");
check("the rewind is sent as the extension's command", sent?.command === "/rewind 3", String(sent?.command));
check("the message reports which snapshot it refers to", sent?.ref === listing.rows[2]?.shortRef, `${sent?.ref} vs ${listing.rows[2]?.shortRef}`);

// 4. The extension wants its own confirmation: that dialog must reach the client.
let dialog: any = null;
for (let attempt = 0; attempt < 20 && !dialog; attempt++) {
	await wait(500);
	dialog = client.messages.slice(before).find((m) => m.type === "ui_request" && m.request?.method === "confirm");
}
check("the extension asks for confirmation through the client", Boolean(dialog), dialog?.request?.title);
check("the confirmation names the snapshot", String(dialog?.request?.message ?? "").includes("2026-10-05"), String(dialog?.request?.message ?? "").slice(0, 80));
// Cancelling must not restore anything: answer the dialog with "no".
if (dialog) {
	client.send({ type: "ui_response", id: dialog.request.id, confirmed: false });
	await wait(1500);
	const after = client.messages.slice(before).map((m) => JSON.stringify(m)).join("|");
	check("cancelling the dialog is acknowledged by the extension", /rewind cancelled/i.test(after), after.slice(-160));
}
check("the workspace tree was not touched by a cancelled rewind", readFileSync(join(repo, "a.txt"), "utf8").includes("one"));

// 5. A live run blocks a rewind (static check: the guard exists in the store as well).
const store = readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "web", "src", "stores", "session.ts"), "utf8");
check("the client also refuses a rewind while a run is active", /a run is active: rewind changes the working tree/.test(store));
check("the panel offers the conversation-tree variant", /rewind\(entry.index, true\)/.test(readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "web", "src", "components", "SettingsPanel.vue"), "utf8")));

client.socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
