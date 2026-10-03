/**
 * Approval disconnect semantics (todo #12): a dialog that nobody answers must block the tool
 * — never be auto-allowed, never be replayed — and a reconnecting client must still receive it.
 *
 * Sequence: prompt triggers a policy ask → the client drops its socket while the dialog is
 * pending → the service must still report it pending and no side effect may appear → a second
 * client sees the dialog in its `hello` and answers Deny → the command must not have run.
 */
import { WebSocket } from "ws";
import { access, rm } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://127.0.0.1:7801";
const SIDE_EFFECT = process.env.SIDE_EFFECT ?? "/tmp/piwebui_disconnect_probe";
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(label) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
		const messages = [];
		socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		socket.on("open", () => resolve({ label, socket, messages, send: (m) => socket.send(JSON.stringify(m)) }));
		socket.on("error", reject);
	});
}

const waitFor = async (fn, ms = 90_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await wait(250);
	}
	return null;
};

const dialogOf = (client) =>
	client.messages
		.filter((m) => (m.type === "record" && m.record?.type === "extension_ui_request") || m.type === "ui_request")
		.map((m) => m.record ?? m.request)
		.find((record) => record?.method === "select" && /chmod|permission|approve/i.test(`${record.title ?? ""} ${record.message ?? ""}`));

await rm(SIDE_EFFECT, { force: true });
const health = await (await fetch(`${BASE}/api/health`)).json();
if (!health.active) {
	console.log("FAIL  service has no active workspace");
	process.exit(1);
}

// --- 1. trigger the ask ------------------------------------------------------
const first = await open("first");
first.send({ type: "prompt", message: `Run exactly this bash command and nothing else: chmod 777 ${SIDE_EFFECT}` });
const dialog = await waitFor(() => dialogOf(first));
check("a policy ask reaches the client as a dialog", Boolean(dialog), dialog ? `${dialog.method} · ${String(dialog.title).slice(0, 60)}` : "no dialog seen");
if (!dialog) {
	console.log("\n0 checks passed — cannot continue without a dialog");
	process.exit(1);
}

// --- 2. the browser goes away ------------------------------------------------
first.socket.close();
await wait(1200);
const afterDisconnect = await (await fetch(`${BASE}/api/health`)).json();
check(
	"the dialog stays pending after the client disconnects",
	afterDisconnect.workspaces.some((workspace) => workspace.pendingUi > 0),
	JSON.stringify(afterDisconnect.workspaces.map((w) => w.pendingUi)),
);
let sideEffect = true;
try {
	await access(SIDE_EFFECT);
} catch {
	sideEffect = false;
}
check("nothing was auto-allowed while disconnected", sideEffect === false, `side effect exists: ${sideEffect}`);

// --- 3. a reconnecting client still gets it, and answers ----------------------
const second = await open("second");
const hello = await waitFor(() => second.messages.find((m) => m.type === "hello"));
const pendingInHello = (hello?.pendingUi ?? []).some((record) => record.id === dialog.id);
check("a reconnecting client still receives the pending dialog", pendingInHello, `${(hello?.pendingUi ?? []).length} pending in hello`);

second.send({ type: "ui_response", id: dialog.id, value: "Deny" });
await wait(2500);

const resolved = await waitFor(() => second.messages.find((m) => m.type === "ui_resolved" && m.id === dialog.id), 15_000);
check("answering resolves the dialog exactly once", Boolean(resolved), JSON.stringify(resolved?.response ?? {}));

let ran = true;
try {
	await access(SIDE_EFFECT);
} catch {
	ran = false;
}
check("denying blocked the command (no side effect)", ran === false, `side effect exists: ${ran}`);

const finalHealth = await (await fetch(`${BASE}/api/health`)).json();
check(
	"no dialog is left pending at the end",
	finalHealth.workspaces.every((workspace) => workspace.pendingUi === 0),
	JSON.stringify(finalHealth.workspaces.map((w) => w.pendingUi)),
);

second.socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
