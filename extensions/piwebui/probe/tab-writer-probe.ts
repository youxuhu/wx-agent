/**
 * One writer per workspace, at tab granularity.
 *
 * Facts pinned here:
 *  - the first tab to write claims the pen without ceremony (single-tab use is unchanged);
 *  - a second tab's write is refused and the refusal names the holder;
 *  - taking over is explicit and the losing tab is told (`writer_revoked`);
 *  - reads are never gated, and a closed tab releases the pen.
 *
 * Usage: node probe/tab-writer-probe.ts [port]
 */
import { WebSocket } from "ws";

const port = Number(process.argv[2] ?? 7796);
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<{ socket: any; messages: any[]; send: (m: Record<string, unknown>) => void; close: () => void }> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages: any[] = [];
	socket.on("message", (raw: unknown) => messages.push(JSON.parse(String(raw))));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	await wait(1500);
	return { socket, messages, send: (m) => socket.send(JSON.stringify(m)), close: () => socket.close() };
}

const helloOf = (client: { messages: any[] }) => client.messages.find((m) => m.type === "hello");
const errorSince = (client: { messages: any[] }, from: number) =>
	client.messages.slice(from).find((m) => m.type === "error") as { message?: string; code?: string } | undefined;

const a = await connect();
const b = await connect();

check("both tabs get an identity", Boolean(helloOf(a)?.clientId && helloOf(b)?.clientId), `${helloOf(a)?.clientId} / ${helloOf(b)?.clientId}`);
check("the identities differ", helloOf(a)?.clientId !== helloOf(b)?.clientId);

// Reads are never gated by the pen.
a.send({ type: "get_state" });
b.send({ type: "get_state" });
await wait(1500);
const readOf = (client: { messages: any[] }) => client.messages.find((m) => m.type === "record" && m.record?.command === "get_state");
check("a reading tab is never refused", Boolean(readOf(a)) && Boolean(readOf(b)));

// A writes first: it claims the pen on its own.
const aFrom = a.messages.length;
a.send({ type: "compact" });
await wait(1500);
check("the first writing tab is not refused", !errorSince(a, aFrom), errorSince(a, aFrom)?.message);
const claimed = a.messages.slice(aFrom).find((m) => m.type === "writer_state");
check("the claim is announced as state", claimed?.holder === helloOf(a)?.clientId, `holder=${claimed?.holder}`);

// B is refused, and the refusal is specific.
const bFrom = b.messages.length;
b.send({ type: "compact" });
await wait(1500);
const refusal = errorSince(b, bFrom);
check("a second tab's write is refused", Boolean(refusal), refusal?.message);
check("the refusal names the holding tab", String(refusal?.message ?? "").includes(String(helloOf(a)?.clientId)));
check("the refusal is machine-readable", refusal?.code === "not-writer", String(refusal?.code));
check("B is told who holds the pen (state is broadcast, not just refused)", b.messages.some((m) => m.type === "writer_state" && m.holder === helloOf(a)?.clientId));

// Taking over is explicit.
b.send({ type: "claim_writer" });
await wait(800);
check("an unforced claim does not steal the pen", b.messages.at(-1)?.holder !== helloOf(b)?.clientId);
const aBeforeTakeover = a.messages.length;
b.send({ type: "claim_writer", force: true });
await wait(1200);
check("a forced claim takes the pen", b.messages.filter((m) => m.type === "writer_state").at(-1)?.holder === helloOf(b)?.clientId);
check("the losing tab is told (not left guessing)", a.messages.slice(aBeforeTakeover).some((m) => m.type === "writer_revoked" && m.by === helloOf(b)?.clientId));

// And the loser really cannot write any more.
const aAfter = a.messages.length;
a.send({ type: "compact" });
await wait(1200);
check("the previous holder's write is refused after losing the pen", Boolean(errorSince(a, aAfter)), errorSince(a, aAfter)?.message);

// A closed tab releases the pen.
b.close();
await wait(1500);
check("closing the holding tab releases the pen", a.messages.filter((m) => m.type === "writer_state").at(-1)?.holder === null, String(a.messages.filter((m) => m.type === "writer_state").at(-1)?.holder));
const aReclaim = a.messages.length;
a.send({ type: "compact" });
await wait(1200);
check("the remaining tab can write again without ceremony", !errorSince(a, aReclaim), errorSince(a, aReclaim)?.message);

a.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
