/**
 * Dev probe: connect to the local service like the browser does, send one prompt,
 * print the records it receives, then exit. Used to verify the RPC bridge end to end.
 *
 * Usage: node probe/ws-probe.ts "<prompt>" [--port 7799] [--seconds 60]
 */

import { WebSocket } from "ws";

const args = process.argv.slice(2);
const prompt = args.find((value) => !value.startsWith("--")) ?? "reply with the single word: pong";
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 7799;
const secondsIndex = args.indexOf("--seconds");
const seconds = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : 60;

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const seen = new Map<string, number>();

socket.on("open", () => {
	console.log(`[probe] connected; sending prompt: ${prompt}`);
	socket.send(JSON.stringify({ type: "prompt", message: prompt }));
});

socket.on("message", (raw) => {
	const record = JSON.parse(String(raw)) as { type: string; [key: string]: unknown };
	if (record.type === "record") {
		const inner = record.record as { type: string; assistantMessageEvent?: { type: string; delta?: string } };
		seen.set(inner.type, (seen.get(inner.type) ?? 0) + 1);
		if (inner.type === "message_update" && inner.assistantMessageEvent?.type === "text_delta") {
			process.stdout.write(inner.assistantMessageEvent.delta ?? "");
			return;
		}
		if (inner.type === "tool_execution_start") {
			const inner2 = inner as unknown as { toolName: string; args: unknown };
			console.log(`\n[probe] tool: ${inner2.toolName} ${JSON.stringify(inner2.args).slice(0, 160)}`);
			return;
		}
		if (inner.type === "tool_execution_end") {
			const inner2 = inner as unknown as { toolName: string; isError?: boolean };
			console.log(`[probe] tool done: ${inner2.toolName} error=${Boolean(inner2.isError)}`);
			return;
		}
		if (inner.type === "agent_settled" || inner.type === "agent_end") {
			console.log(`\n[probe] ${inner.type}`);
			if (inner.type === "agent_settled") finish(0);
			return;
		}
		if (inner.type === "extension_ui_request") {
			console.log(`\n[probe] extension UI request: ${JSON.stringify(inner).slice(0, 300)}`);
			return;
		}
		return;
	}
	if (record.type === "error") console.error(`[probe] error: ${record.message}`);
	else if (record.type === "pi_stderr") process.stderr.write(String(record.chunk ?? ""));
});

function finish(code: number): void {
	console.log(`\n[probe] event counts: ${JSON.stringify(Object.fromEntries(seen))}`);
	socket.close();
	setTimeout(() => process.exit(code), 100);
}

socket.on("error", (error) => {
	console.error(`[probe] socket error: ${String(error)}`);
	process.exit(1);
});

setTimeout(() => {
	console.log(`\n[probe] timed out after ${seconds}s`);
	finish(2);
}, seconds * 1000);
