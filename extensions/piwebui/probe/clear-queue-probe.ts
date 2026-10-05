/**
 * Taking queued messages back (`clear_queue`).
 *
 * Facts this pins down:
 *  - the RPC command is reachable through the server (it used to answer "unknown client message type");
 *  - the queued text comes back in the response, so a client can restore it instead of dropping it;
 *  - a second, non-active socket cannot clear another workspace's queue (single writer).
 *
 * Usage: node probe/clear-queue-probe.ts [port] [--live]
 *   Without --live it only checks the protocol surface (cheap, no model call).
 *   With --live it runs one real turn on a cheap model, queues two messages, clears them.
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv[2] ?? 7796);
const live = process.argv.includes("--live");
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
	socket: any;
	messages: any[];
	send: (message: Record<string, unknown>) => void;
	records: (command: string) => any[];
}

async function connect(): Promise<Client> {
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
		send: (message) => socket.send(JSON.stringify(message)),
		records: (command) => messages.filter((m) => m.type === "record" && m.record?.command === command),
	};
}

const client = await connect();

// 1. The command is in the server's vocabulary (it used to answer "unknown client message type").
client.send({ type: "clear_queue", nonsense: 1 });
await wait(1200);
const answered = client.records("clear_queue").at(-1);
check("clear_queue is reachable and answered by pi", Boolean(answered), answered ? `success=${answered.record.success}` : "no response record");
check("an unexpected field does not break the no-parameter command", Boolean(answered) && answered.record.success === true);
check("the answer carries the two queues", Boolean(answered) && Array.isArray(answered.record.data?.steering) && Array.isArray(answered.record.data?.followUp));

// 2. Nothing queued yet: the answer is empty, not an error.
check("an empty queue clears to two empty lists", Boolean(answered) && (answered.record.data?.steering as string[]).length === 0 && (answered.record.data?.followUp as string[]).length === 0);

// 3. A different workspace cannot clear this one's queue (write gate).
const other = await connect();
other.send({ type: "clear_queue", workspace: "/tmp/definitely-not-a-workspace" });
await wait(800);
const refused = other.messages.find((m) => m.type === "error" && /unknown workspace/.test(String(m.message)));
check("a foreign workspace is refused", Boolean(refused), refused?.message);
other.socket.close();

if (live) {
	// 4. A real run queueing two messages, then taking them back.
	const before = client.records("clear_queue").length;
	// A long answer keeps the run alive while the two messages are queued.
	client.send({ type: "prompt", message: "Write a detailed 2000-word essay about the history of tea. Plain text, no lists." });
	await wait(3000);
	client.send({ type: "prompt", message: "first queued text", streamingBehavior: "steer" });
	client.send({ type: "prompt", message: "second queued text", streamingBehavior: "followUp" });
	let queued = 0;
	let dispositions: string[] = [];
	for (let attempt = 0; attempt < 15; attempt++) {
		await wait(1000);
		dispositions = client
			.records("prompt")
			.slice(-2)
			.map((entry) => String(entry.record.data?.disposition ?? ""));
		if (dispositions.every((value) => value === "queued")) break;
	}
	// This is the fact the UI derives its queue count from (pi answers each prompt as it takes it).
	check("pi confirms both messages as queued while the run is active", dispositions.length === 2 && dispositions.every((value) => value === "queued"), dispositions.join(","));
	void queued;
	client.send({ type: "clear_queue" });
	await wait(2500);
	const cleared = client.records("clear_queue").at(-1);
	const texts = [...(cleared?.record.data?.steering ?? []), ...(cleared?.record.data?.followUp ?? [])];
	check("both queued texts come back so the client can restore them", texts.length === 2, JSON.stringify(texts));
	check("the returned text is the queued text", texts.includes("first queued text") && texts.includes("second queued text"), JSON.stringify(texts));
	check("the response is a newer one (not a cached record)", client.records("clear_queue").length > before);
	// pi reports the drained queue on its own schedule (after a turn), so this is what keeps the UI honest.
	let remaining = -1;
	for (let attempt = 0; attempt < 40 && remaining !== 0; attempt++) {
		await wait(1000);
		const after = client.records("queue_update").at(-1)?.record;
		remaining = (after?.steering?.length ?? 0) + (after?.followUp?.length ?? 0);
	}
	check("pi later reports the queue as empty (authoritative correction)", remaining === 0, `remaining=${remaining}`);
	client.send({ type: "abort" });
}

// 5. The client handler exists and restores the text (static check: the behaviour lives in the store).
const store = readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "web", "src", "stores", "session.ts"), "utf8");
check("the store has a clearQueue action", /clearQueue\(\)/.test(store));
check("the store restores the cleared text into the composer", /case "clear_queue":/.test(store) && /insertIntoPrompt/.test(store.slice(store.indexOf('case "clear_queue":'), store.indexOf('case "clear_queue":') + 900)));

client.socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${live ? " (live)" : ""}`);
if (failed.length) process.exit(1);
