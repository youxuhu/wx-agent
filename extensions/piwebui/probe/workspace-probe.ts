/** Workspace registry acceptance: open/switch/close, per-workspace sessions, single writer. */
import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:7799";
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
		const messages = [];
		socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		socket.on("open", () => resolve({ socket, messages, send: (m) => socket.send(JSON.stringify(m)) }));
		socket.on("error", reject);
	});
}
const waitFor = async (fn, ms = 20000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await wait(200);
	}
	return null;
};
const responses = (messages, command) => messages.filter((m) => m.type === "record" && m.record?.command === command);
const newResponse = async (messages, command, ms = 20000) => {
	const seen = responses(messages, command).length;
	return waitFor(() => {
		const hits = responses(messages, command);
		return hits.length > seen ? hits[hits.length - 1].record : null;
	}, ms);
};

const { socket, messages, send } = await connect();
const A = process.env.WS_A ?? "/tmp";
const candidates = [process.env.WS_B, "/tmp/piwebui-preview", "/Users/revy/project/minepi", "/Users/revy/project/moveDroid_text"].filter(Boolean);

const health = await (await fetch(`${BASE}/api/health`)).json();
check("health lists workspaces with an active one", Array.isArray(health.workspaces) && health.workspaces.length === 1 && health.active === health.workspaces[0].path, `${health.workspaces?.length} workspace(s), active=${health.active}`);

// open (not activate) another workspace that is not already in the registry
const openPaths = new Set((health.workspaces ?? []).map((workspace) => workspace.path));
const B = candidates.find((candidate) => !openPaths.has(candidate) && !openPaths.has(`/private${candidate}`)) ?? candidates[0];

send({ type: "open_workspace", path: B, activate: false });
const listed = await waitFor(() => {
	const message = messages.filter((m) => m.type === "workspaces").pop();
	return message && message.workspaces.length === 2 ? message : null;
});
check("open_workspace adds a second workspace", Boolean(listed), listed ? listed.workspaces.map((w) => w.path).join(" | ") : "no update");
const bPath = listed?.workspaces.find((w) => w.path !== health.active)?.path;
check("the new workspace resolved to a canonical path", Boolean(bPath) && !bPath.includes(".."), String(bPath));

// single writer: a prompt to the non-active workspace must be refused
send({ type: "prompt", message: "should be refused", workspace: bPath });
const refusal = await waitFor(() => messages.find((m) => m.type === "error" && /not the active workspace/.test(m.message)));
check("writes to a non-active workspace are refused", Boolean(refusal), refusal?.message?.slice(0, 110));

// switch: now the other one is active and accepts reads
send({ type: "switch_workspace", path: bPath });
const switched = await waitFor(() => {
	const message = messages.filter((m) => m.type === "workspaces").pop();
	return message && message.active === bPath ? message : null;
});
check("switch_workspace changes the active workspace", Boolean(switched), `active=${switched?.active}`);

send({ type: "get_state" });
const state = await newResponse(messages, "get_state");
check("the switched workspace answers RPC reads", state?.success === true, JSON.stringify(state?.data?.sessionFile ?? {}));

send({ type: "list_sessions", workspace: health.active });
const sessions = await waitFor(() => messages.filter((m) => m.type === "sessions").pop());
check("sessions are listed per workspace", Boolean(sessions) && sessions.workspace === health.active, `${sessions?.items?.length} sessions for ${sessions?.workspace}`);

// now A is not active anymore → its writes are refused too
const refusalsBefore = messages.filter((m) => m.type === "error" && /not the active workspace/.test(m.message)).length;
send({ type: "prompt", message: "should be refused too", workspace: health.active });
const refusal2 = await waitFor(() => {
	const hits = messages.filter((m) => m.type === "error" && /not the active workspace/.test(m.message));
	return hits.length > refusalsBefore ? hits[hits.length - 1] : null;
});
check(
	"the previously active workspace is now read-only",
	Boolean(refusal2) && refusal2.message.includes(`refused: ${health.active}`) && refusal2.message.includes(`active: ${bPath}`),
	refusal2?.message?.slice(0, 120),
);

// close the inactive one and confirm it disappears
send({ type: "close_workspace", path: health.active });
const closed = await waitFor(() => {
	const message = messages.filter((m) => m.type === "workspaces").pop();
	return message && !message.workspaces.some((w) => w.path === health.active) ? message : null;
});
check("close_workspace removes it from the registry", Boolean(closed), closed ? closed.workspaces.map((w) => w.path).join(" | ") : "still there");

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
