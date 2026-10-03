/**
 * Session store: one WebSocket to the local pi-web-ui service, which bridges a
 * supervised `pi --mode rpc` child.
 *
 * Facts only: this store renders what pi reports and never invents state. An
 * approval dialog that was never answered stays pending — it is never treated as
 * "allowed" (see PLAN.md §5).
 */

import { defineStore } from "pinia";
import {
	blocksToText,
	messageToText,
	type Block,
	type ChatMessage,
	type ConnState,
	type ToolRun,
	type UiRequest,
} from "../types.ts";

interface WireRecord {
	type: string;
	id?: string;
	[key: string]: unknown;
}

export const useSessionStore = defineStore("session", {
	state: () => ({
		conn: "connecting" as ConnState,
		cwd: "",
		piState: "stopped" as string,
		exitInfo: null as null | { code: number | null; signal: string | null; at: string },
		messages: [] as ChatMessage[],
		tools: {} as Record<string, ToolRun>,
		pendingUi: [] as UiRequest[],
		running: false,
		lastError: "" as string,
		stderr: [] as string[],
		usage: null as null | { input: number; output: number; totalTokens: number; cost: number },
		queueSteering: 0,
		queueFollowUp: 0,
		retry: null as null | { attempt: number; max: number; reason: string },
	}),

	actions: {
		connect(): void {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const socket = new WebSocket(`${proto}://${location.host}/ws`);
			this.conn = "connecting";

			socket.addEventListener("open", () => {
				this.conn = "open";
			});
			socket.addEventListener("close", () => {
				this.conn = "closed";
			});
			socket.addEventListener("error", () => {
				this.conn = "error";
				this.lastError = "websocket error";
			});
			socket.addEventListener("message", (event) => {
				let payload: { type?: string; [key: string]: unknown };
				try {
					payload = JSON.parse(String(event.data));
				} catch {
					this.lastError = "malformed message from service";
					return;
				}
				this.handle(payload);
			});
			(this as unknown as { socket: WebSocket }).socket = socket;
		},

		send(message: Record<string, unknown>): void {
			const socket = (this as unknown as { socket?: WebSocket }).socket;
			if (socket?.readyState === 1) socket.send(JSON.stringify(message));
			else this.lastError = "not connected to the local service";
		},

		handle(payload: { type?: string; [key: string]: unknown }): void {
			switch (payload.type) {
				case "hello": {
					this.cwd = String(payload.cwd ?? "");
					this.piState = String(payload.state ?? "unknown");
					this.exitInfo = (payload.exitInfo as typeof this.exitInfo) ?? null;
					const pending = (payload.pendingUi as UiRequest[] | undefined) ?? [];
					this.pendingUi = pending;
					return;
				}
				case "pi_state": {
					this.piState = String(payload.state ?? this.piState);
					if (payload.code !== undefined || payload.signal !== undefined) {
						this.exitInfo = {
							code: (payload.code as number | null) ?? null,
							signal: (payload.signal as string | null) ?? null,
							at: new Date().toISOString(),
						};
						this.running = false;
					}
					if (payload.error) this.lastError = String(payload.error);
					return;
				}
				case "pi_stderr": {
					this.stderr.push(String(payload.chunk ?? ""));
					if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
					return;
				}
				case "record":
					this.handleRecord(payload.record as WireRecord);
					return;
				case "ui_resolved": {
					const id = String(payload.id ?? "");
					this.pendingUi = this.pendingUi.filter((request) => request.id !== id);
					return;
				}
				case "malformed":
					this.lastError = `pi sent a malformed record: ${String(payload.line ?? "").slice(0, 200)}`;
					return;
				case "error":
					this.lastError = String(payload.message ?? "unknown error");
					return;
				default:
					return;
			}
		},

		handleRecord(record: WireRecord): void {
			switch (record.type) {
				case "agent_start":
					this.running = true;
					return;
				case "agent_end":
				case "agent_settled":
					this.running = false;
					for (const message of this.messages) message.done = true;
					return;
				case "message_start": {
					const message = record.message as { role?: string; id?: string } | undefined;
					const role = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : "system";
					const id = String(message?.id ?? `m-${this.messages.length}-${Date.now()}`);
					// user echoes arrive as their own message; assistant messages stream below
					this.messages.push({ id, role, blocks: role === "user" ? [{ kind: "text", text: messageToText(message) }] : [], done: role === "user" });
					return;
				}
				case "message_update":
					this.applyUpdate(record);
					return;
				case "message_end": {
					const message = record.message as { role?: string; id?: string; stopReason?: string; errorMessage?: string } | undefined;
					const current = this.currentAssistant();
					if (current && message?.role === "assistant") {
						// an errored response carries no content: report the provider error verbatim
						if (message.stopReason === "error" || message.errorMessage) {
							current.blocks = [{ kind: "text", text: `model error: ${message.errorMessage ?? message.stopReason ?? "unknown error"}` }];
							this.lastError = `${message.errorMessage ?? message.stopReason ?? "model error"}`;
						} else {
							current.blocks = [{ kind: "text", text: messageToText(message) }];
						}
						current.done = true;
					}
					return;
				}
				case "tool_execution_start": {
					const toolCallId = String(record.toolCallId ?? "");
					const toolName = String(record.toolName ?? "tool");
					this.tools[toolCallId] = {
						toolCallId,
						toolName,
						args: record.args,
						output: "",
						partial: "",
						status: "running",
						startedAt: Date.now(),
					};
					const current = this.currentAssistant();
					if (current && !current.blocks.some((block) => block.kind === "tool" && block.toolCallId === toolCallId)) {
						current.blocks.push({ kind: "tool", toolCallId });
					}
					return;
				}
				case "tool_execution_update": {
					const toolCallId = String(record.toolCallId ?? "");
					const run = this.tools[toolCallId];
					if (run) run.partial = blocksToText((record.partialResult as { content?: unknown })?.content ?? record.partialResult);
					return;
				}
				case "tool_execution_end": {
					const toolCallId = String(record.toolCallId ?? "");
					const run = this.tools[toolCallId];
					if (run) {
						run.output = blocksToText((record.result as { content?: unknown })?.content ?? record.result);
						run.status = record.isError ? "error" : "done";
						run.endedAt = Date.now();
					}
					return;
				}
				case "queue_update": {
					// pi reports the complete current queues under `steering` and `followUp`.
					this.queueSteering = Array.isArray(record.steering) ? (record.steering as unknown[]).length : 0;
					this.queueFollowUp = Array.isArray(record.followUp) ? (record.followUp as unknown[]).length : 0;
					return;
				}
				case "auto_retry_start":
					this.retry = { attempt: Number(record.attempt ?? 0), max: Number(record.maxAttempts ?? 0), reason: String(record.errorMessage ?? "") };
					return;
				case "auto_retry_end":
					this.retry = null;
					if (record.success === false) this.lastError = `retries exhausted: ${String(record.finalError ?? "")}`;
					return;
				case "extension_ui_request": {
					const request = record as unknown as UiRequest;
					if (!this.pendingUi.some((item) => item.id === request.id)) this.pendingUi.push(request);
					return;
				}
				case "extension_error":
					this.lastError = `extension error: ${String(record.error ?? record.message ?? "").slice(0, 300)}`;
					return;
				case "usage":
				case "turn_end": {
					const usage = (record.usage ?? (record as { message?: { usage?: unknown } }).message?.usage) as
						| { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }
						| undefined;
					if (usage) {
						this.usage = {
							input: usage.input ?? 0,
							output: usage.output ?? 0,
							totalTokens: usage.totalTokens ?? 0,
							cost: usage.cost?.total ?? 0,
						};
					}
					return;
				}
				default:
					return;
			}
		},

		applyUpdate(record: WireRecord): void {
			const update = record.assistantMessageEvent as
				| { type: string; contentIndex?: number; delta?: string; content?: string; id?: string; toolName?: string }
				| undefined;
			if (!update) return;
			const current = this.currentAssistant() ?? this.pushAssistant();
			const index = update.contentIndex ?? 0;

			const ensureBlock = (kind: "text" | "thinking"): { kind: "text" | "thinking"; text: string } => {
				while (current.blocks.length <= index) current.blocks.push({ kind, text: "" });
				const block = current.blocks[index];
				if (block && block.kind === kind) return block as { kind: "text" | "thinking"; text: string };
				const replacement = { kind, text: "" };
				current.blocks[index] = replacement;
				return replacement;
			};

			switch (update.type) {
				case "text_delta":
					ensureBlock("text").text += update.delta ?? "";
					return;
				case "text_end":
					ensureBlock("text").text = update.content ?? "";
					return;
				case "thinking_delta":
					ensureBlock("thinking").text += update.delta ?? "";
					return;
				case "thinking_end":
					ensureBlock("thinking").text = update.content ?? "";
					return;
				default:
					return;
			}
		},

		currentAssistant(): ChatMessage | undefined {
			return this.messages.filter((message) => message.role === "assistant").at(-1);
		},

		pushAssistant(): ChatMessage {
			const message: ChatMessage = { id: `a-${Date.now()}`, role: "assistant", blocks: [], done: false };
			this.messages.push(message);
			return message;
		},

		// ---- actions the UI calls ----
		sendPrompt(text: string): void {
			if (!text.trim()) return;
			this.send({ type: "prompt", message: text });
		},
		steer(text: string): void {
			this.send({ type: "steer", message: text });
		},
		abort(): void {
			this.send({ type: "abort" });
		},
		newSession(): void {
			this.messages = [];
			this.tools = {};
			this.send({ type: "new_session" });
		},
		compact(): void {
			this.send({ type: "compact" });
		},
		answerSelect(id: string, value: string | undefined): void {
			if (value === undefined) this.send({ type: "ui_response", id, cancelled: true });
			else this.send({ type: "ui_response", id, value });
		},
		answerConfirm(id: string, confirmed: boolean): void {
			this.send({ type: "ui_response", id, confirmed });
		},
		answerInput(id: string, value: string | undefined): void {
			if (value === undefined) this.send({ type: "ui_response", id, cancelled: true });
			else this.send({ type: "ui_response", id, value });
		},
	},
});
