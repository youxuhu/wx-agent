/**
 * Run lifecycle regression (the "error never clears / cannot answer again" bug):
 *  - a plain prompt during a run must be rejected by pi (documents why the client sends a
 *    streamingBehavior instead),
 *  - the same prompt with `streamingBehavior: "followUp"` must be accepted,
 *  - after the run settles, a further plain prompt must be accepted again (the run state must
 *    return to idle, which is what the client-side fix relies on).
 */
import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:7799";
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
const messages = [];
socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
await new Promise((resolve, reject) => {
	socket.on("open", resolve);
	socket.on("error", reject);
});
const send = (message) => socket.send(JSON.stringify(message));
const responses = () => messages.filter((m) => m.type === "record" && m.record?.type === "response");
const events = (type) => messages.filter((m) => m.type === "record" && m.record?.type === type);
const waitFor = async (fn, ms = 90_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await wait(200);
	}
	return null;
};

send({ type: "prompt", message: "reply with exactly: life-one" });
const started = await waitFor(() => events("agent_start").length > 0, 60_000);
check("a run starts", Boolean(started), started ? "agent_start seen" : "no agent_start");

// while streaming: a plain prompt has no legal meaning for pi
const before = responses().length;
send({ type: "prompt", message: "reply with exactly: life-two" });
const plain = await waitFor(() => responses().slice(before).find((r) => r.record?.command === "prompt"), 15_000);
check(
	"a plain prompt during a run is rejected (that is what we must avoid)",
	plain?.record?.success === false,
	plain ? `success=${plain.record.success} ${String(plain.record.error?.message ?? "").slice(0, 60)}` : "no response",
);

const beforeFollow = responses().length;
send({ type: "prompt", message: "reply with exactly: life-three", streamingBehavior: "followUp" });
const follow = await waitFor(() => responses().slice(beforeFollow).find((r) => r.record?.command === "prompt"), 15_000);
check("the same message as a follow-up is accepted", follow?.record?.success === true, `success=${follow?.record?.success} disposition=${follow?.record?.data?.disposition}`);

const settled = await waitFor(() => events("agent_settled").length > 0, 180_000);
check("the run settles", Boolean(settled), settled ? "agent_settled seen" : "never settled (model may be unavailable)");

if (settled) {
	await wait(1500);
	const beforeIdle = responses().length;
	send({ type: "prompt", message: "reply with exactly: life-four" });
	const idle = await waitFor(() => responses().slice(beforeIdle).find((r) => r.record?.command === "prompt"), 30_000);
	check("after settling, a plain prompt is accepted again", idle?.record?.success === true, `success=${idle?.record?.success}`);
}

send({ type: "get_state" });
const state = await waitFor(() => responses().find((r) => r.record?.command === "get_state"));
check(
	"get_state reports a boolean isStreaming (the client reconciles against it)",
	typeof state?.record?.data?.isStreaming === "boolean",
	`isStreaming=${String(state?.record?.data?.isStreaming)}`,
);

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
