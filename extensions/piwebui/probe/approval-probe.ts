/**
 * Approval probe: drive one prompt that makes the agent attempt a command our `policy`
 * extension asks about, then answer the dialog and report what happened.
 *
 * Usage:
 *   node probe/approval-probe.ts --answer "Deny"            # answer by option text
 *   node probe/approval-probe.ts --cancel                   # dismiss (must count as NOT approved)
 *   node probe/approval-probe.ts --answer "Allow once"
 */

import { WebSocket } from "ws";

const args = process.argv.slice(2);
const answerIndex = args.indexOf("--answer");
const answer = answerIndex >= 0 ? args[answerIndex + 1] : "Deny";
const cancel = args.includes("--cancel");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 7799;
const prompt = args.find((value) => !value.startsWith("--") && value !== answer) ?? "Run this exact bash command and nothing else: git push";

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const seenDialog = { yes: false };
let toolStart: Record<string, unknown> | null = null;
const toolResults: string[] = [];

socket.on("open", () => {
	console.log(`[probe] prompt: ${prompt}`);
	socket.send(JSON.stringify({ type: "prompt", message: prompt }));
});

socket.on("message", (raw) => {
	const payload = JSON.parse(String(raw)) as { type: string; [key: string]: unknown };
	if (payload.type === "error") {
		console.log(`[probe] service error: ${payload.message}`);
		return;
	}
	if (payload.type !== "record") return;
	const record = payload.record as { type: string; [key: string]: unknown };

	if (record.type === "extension_ui_request" && record.method === "select") {
		seenDialog.yes = true;
		console.log(`[probe] DIALOG ${record.id}`);
		console.log(`         title:   ${String(record.title ?? "").slice(0, 200)}`);
		console.log(`         options: ${JSON.stringify(record.options)}`);
		console.log(`         timeout: ${record.timeout ?? "(none — waits until answered)"}`);
		setTimeout(() => {
			if (cancel) {
				console.log("[probe] dismissing the dialog (cancelled:true) — pi must see 'not approved'");
				socket.send(JSON.stringify({ type: "ui_response", id: record.id, cancelled: true }));
			} else {
				console.log(`[probe] answering: ${answer}`);
				socket.send(JSON.stringify({ type: "ui_response", id: record.id, value: answer }));
			}
		}, 500);
		return;
	}

	if (record.type === "tool_execution_start") {
		toolStart = record;
		console.log(`[probe] tool started: ${record.toolName} ${JSON.stringify(record.args).slice(0, 160)}`);
		return;
	}
	if (record.type === "tool_execution_end") {
		const result = record.result as { content?: Array<{ text?: string }> } | undefined;
		const text = result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
		toolResults.push(text);
		console.log(`[probe] tool ended (isError=${Boolean(record.isError)}): ${text.replace(/\s+/g, " ").slice(0, 300)}`);
		return;
	}
	if (record.type === "message_update") {
		const update = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
		if (update?.type === "text_delta") process.stdout.write(update.delta ?? "");
		return;
	}
	if (record.type === "agent_settled") {
		const blocked = toolResults.some((text) => /not approved|policy|denied|blocked/i.test(text)) || !toolStart;
		console.log(`\n[probe] settled | dialog shown: ${seenDialog.yes} | tool ran: ${Boolean(toolStart)} | blocked-looking: ${blocked}`);
		socket.close();
		setTimeout(() => process.exit(0), 150);
	}
});

socket.on("error", (error) => {
	console.error(`[probe] socket error: ${String(error)}`);
	process.exit(1);
});

setTimeout(() => {
	console.log("\n[probe] timed out (90s)");
	process.exit(2);
}, 90_000);
