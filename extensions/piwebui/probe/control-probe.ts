/**
 * Control-surface acceptance probe: every capability the web UI exposes must be a real
 * RPC command with a real answer. Anything unknown or incomplete is refused, not faked.
 */
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://127.0.0.1:7801";
const AGENT_DIR = process.env.AGENT_DIR ?? "/tmp/piwebui-testagent";

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function connect() {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
		const messages = [];
		socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		socket.on("open", () => resolve({ socket, messages, send: (m) => socket.send(JSON.stringify(m)) }));
		socket.on("error", reject);
	});
}

const responsesFor = (messages, command) =>
	messages.filter((m) => m.type === "record" && m.record?.type === "response" && m.record.command === command);

const responseFor = (messages, command, skip = 0) => {
	const hits = responsesFor(messages, command);
	return hits[hits.length - 1 - skip]?.record ?? null;
};

/** Wait for a *new* response, so a cached earlier answer is never mistaken for a fresh one. */
const waitForNew = async (messages, command, ms = 15000) => {
	const seen = responsesFor(messages, command).length;
	return waitFor(() => {
		const hits = responsesFor(messages, command);
		return hits.length > seen ? hits[hits.length - 1].record : null;
	}, ms);
};

const waitFor = async (fn, ms = 15000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 200));
	}
	return null;
};

const { socket, messages, send } = await connect();

// 1. Discoverable commands (extension commands run through `prompt` as /name).
send({ type: "get_commands" });
const commands = await waitFor(() => responseFor(messages, "get_commands"));
const names = (commands?.data?.commands ?? []).map((c) => c.name);
check("get_commands enumerates commands", names.length > 0, `${names.length}: ${names.slice(0, 10).join(", ")}`);
check("our own extension commands are listed", names.includes("policy") && names.includes("sandbox"), `policy=${names.includes("policy")} sandbox=${names.includes("sandbox")}`);

// 2. An extension command actually executes through prompt → disposition "handled".
send({ id: "cmd-1", type: "prompt", message: "/policy status" });
const handled = await waitFor(() => responseFor(messages, "prompt"));
check("extension command runs via prompt", handled?.success === true && handled?.data?.disposition === "handled", JSON.stringify(handled?.data));

// 3. Models, thinking levels, settings reflect real state.
send({ type: "get_available_models" });
const models = await waitFor(() => responseFor(messages, "get_available_models"));
check("get_available_models returns models", (models?.data?.models ?? []).length > 0, `${(models?.data?.models ?? []).length} models`);

send({ type: "get_available_thinking_levels" });
const levels = await waitFor(() => responseFor(messages, "get_available_thinking_levels"));
const levelList = levels?.data?.levels ?? levels?.data?.thinkingLevels ?? [];
check("get_available_thinking_levels returns levels", levelList.length > 0, levelList.join(", "));

send({ type: "get_state" });
const before = await waitFor(() => responseFor(messages, "get_state"));
check("get_state exposes settings the UI binds to", "autoCompactionEnabled" in (before?.data ?? {}) && "steeringMode" in (before?.data ?? {}), JSON.stringify({ compaction: before?.data?.autoCompactionEnabled, steering: before?.data?.steeringMode, followUp: before?.data?.followUpMode }));

// 4. Changing a setting round-trips.
const target = levelList.find((level) => level !== before?.data?.thinkingLevel) ?? levelList[0];
send({ type: "set_thinking_level", level: target });
const levelResponse = await waitForNew(messages, "set_thinking_level");
send({ type: "get_state" });
const after = await waitForNew(messages, "get_state");
check(
	"set_thinking_level round-trips",
	levelResponse?.success === true && after?.data?.thinkingLevel === target,
	`${before?.data?.thinkingLevel} → ${after?.data?.thinkingLevel} (accepted=${levelResponse?.success})`,
);

send({ type: "set_auto_compaction", enabled: !before?.data?.autoCompactionEnabled });
const compactionResponse = await waitFor(() => responseFor(messages, "set_auto_compaction"));
check("set_auto_compaction accepted", compactionResponse?.success === true, JSON.stringify(compactionResponse?.data ?? {}));
send({ type: "set_auto_compaction", enabled: before?.data?.autoCompactionEnabled ?? true });

// 5. Session tools answer.
send({ type: "get_session_stats" });
const stats = await waitFor(() => responseFor(messages, "get_session_stats"));
check("get_session_stats answers", typeof stats?.data?.totalMessages === "number", JSON.stringify({ messages: stats?.data?.totalMessages, tokens: stats?.data?.tokens?.total, cost: stats?.data?.cost }));

send({ type: "get_tree" });
const tree = await waitFor(() => responseFor(messages, "get_tree"));
check("get_tree answers", Array.isArray(tree?.data?.tree) || Array.isArray(tree?.data), `kind=${Array.isArray(tree?.data?.tree) ? "tree" : Array.isArray(tree?.data) ? "array" : typeof tree?.data}`);

send({ type: "get_fork_messages" });
const forks = await waitFor(() => responseFor(messages, "get_fork_messages"));
check("get_fork_messages answers", forks?.success === true, Object.keys(forks?.data ?? {}).join(","));

send({ type: "get_last_assistant_text" });
const lastText = await waitFor(() => responseFor(messages, "get_last_assistant_text"));
check("get_last_assistant_text answers", lastText?.success === true, `"${String(lastText?.data?.text ?? "").slice(0, 40)}"`);

// 6. Direct shell execution (the TUI's ! escape).
send({ id: "bash-1", type: "bash", command: "echo control-probe-$((6*7))", excludeFromContext: true });
const bash = await waitFor(() => responseFor(messages, "bash"));
check("bash runs a real command", bash?.data?.output?.includes("control-probe-42") && bash?.data?.exitCode === 0, `exit=${bash?.data?.exitCode} out=${JSON.stringify(bash?.data?.output)}`);
check("bash streams bash_execution_update", messages.some((m) => m.type === "record" && m.record?.type === "bash_execution_update"), "delta events seen");

// 7. Refusals: unknown commands and missing fields never reach pi.
send({ type: "login", provider: "anthropic" });
const unknown = await waitFor(() => messages.find((m) => m.type === "error" && /unknown client message type: login/.test(m.message)));
check("undisclosed RPC command is refused", Boolean(unknown), unknown?.message);
send({ type: "set_model" });
const missing = await waitFor(() => messages.find((m) => m.type === "error" && /set_model needs modelId/.test(m.message)));
check("missing required field is refused", Boolean(missing), missing?.message);

// 8. Config API: allowlist, JSON validation, atomic write with backup.
const config = await (await fetch(`${BASE}/api/config`)).json();
const configNames = config.files.map((f) => f.name);
check("config list covers the extension configs", configNames.includes("settings.json") && configNames.includes("policy.json") && configNames.includes("preview.json"), configNames.join(", "));
check("credentials are not exposed", !configNames.includes("auth.json") && !JSON.stringify(config).includes("apiKey"), "auth.json absent");

const forbidden = await fetch(`${BASE}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "auth.json", content: "{}" }) });
check("writing outside the allowlist is refused", forbidden.status === 403 && /refused/.test(await forbidden.text()), `status ${forbidden.status}`);

const badJson = await fetch(`${BASE}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "preview.json", content: "{ not json" }) });
check("invalid JSON is refused before writing", badJson.status === 400, `status ${badJson.status}`);

const current = await readFile(`${AGENT_DIR}/preview.json`, "utf8");
const write = await fetch(`${BASE}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "preview.json", content: current }) });
const writeData = await write.json();
const backup = await readFile(`${AGENT_DIR}/preview.json.bak`, "utf8").catch(() => null);
check("valid JSON is written atomically with a backup", write.status === 200 && writeData.ok === true && backup === current, `backup=${backup ? "ok" : "missing"} takesEffect="${String(writeData.takesEffect).slice(0, 40)}…"`);

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
