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
	messageToBlocks,
	messageToText,
	type ChatMessage,
	type CommandInfo,
	type ConfigFile,
	type ConnState,
	type ForkPoint,
	type ModelInfo,
	type SessionStats,
	type PickPayload,
	type PickRecord,
	type PreviewInfo,
	type SessionSummary,
	type ToolRun,
	type UiRequest,
} from "../types.ts";

/** Only these extension UI methods are dialogs that expect an answer. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

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
		status: {} as Record<string, string>,
		sessions: [] as SessionSummary[],
		currentSessionPath: null as string | null,
		sessionName: null as string | null,
		showSessions: false,
		model: "" as string,
		thinkingLevel: "" as string,
		retry: null as null | { attempt: number; max: number; reason: string },
		// preview side
		previewInfo: null as PreviewInfo | null,
		showPreview: false,
		previewUrl: "" as string,
		previewError: "" as string,
		pickMode: false,
		picks: [] as PickRecord[],
		composerDraft: "" as string,
		composerSeq: 0,
		previewFrameKey: 0,
		// control surface
		showControl: false,
		controlTab: "commands" as string,
		commands: [] as CommandInfo[],
		models: [] as ModelInfo[],
		thinkingLevels: [] as string[],
		stats: null as SessionStats | null,
		tree: [] as unknown[],
		forkPoints: [] as ForkPoint[],
		lastAssistantText: "" as string,
		configFiles: [] as ConfigFile[],
		configName: "" as string,
		configDraft: "" as string,
		configStatus: "" as string,
		shellCommand: "" as string,
		shellOutput: "" as string,
		shellExitCode: null as number | null,
		shellRunning: false,
		shellExcluded: true,
		pendingSends: [] as Record<string, unknown>[],
		autoCompaction: null as boolean | null,
		autoRetry: null as boolean | null,
		steeringMode: "" as string,
		followUpMode: "" as string,
	}),

	actions: {
		connect(): void {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const socket = new WebSocket(`${proto}://${location.host}/ws`);
			this.conn = "connecting";

			socket.addEventListener("open", () => {
				this.conn = "open";
				this.lastError = "";
				// Anything requested while the socket was still connecting goes out now.
				const queued = this.pendingSends;
				this.pendingSends = [];
				for (const message of queued) this.send(message);
				// hydrate: current session + the session list + dev server state
				this.send({ type: "get_state" });
				this.send({ type: "list_sessions" });
				this.send({ type: "preview_status" });
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

		/** Picker results arrive as window messages from the same-origin iframe. */
		listenForPicks(): void {
			window.addEventListener("message", (event: MessageEvent) => {
				const data = event.data as { type?: string; payload?: PickPayload } | undefined;
				if (!data || data.type !== "piwebui:pick" || !data.payload) return;
				if (event.origin !== location.origin) {
					this.lastError = `refused an element pick from origin ${event.origin}`;
					return;
				}
				this.picks = [
					...this.picks,
					{ id: `pick-${Date.now()}-${this.picks.length}`, at: new Date().toLocaleTimeString(), note: "", payload: data.payload },
				].slice(-20);
				this.lastError = "";
			});
		},

		send(message: Record<string, unknown>): void {
			const socket = (this as unknown as { socket?: WebSocket }).socket;
			if (socket?.readyState === 1) {
				socket.send(JSON.stringify(message));
				return;
			}
			// Still connecting: hold the request instead of reporting a failure that isn't one.
			if (socket?.readyState === 0) {
				this.pendingSends = [...this.pendingSends, message].slice(-50);
				return;
			}
			this.lastError = "not connected to the local service";
		},

		handle(payload: { type?: string; [key: string]: unknown }): void {
			switch (payload.type) {
				case "hello": {
					this.cwd = String(payload.cwd ?? "");
					this.piState = String(payload.state ?? "unknown");
					this.currentSessionPath = (payload.currentSessionPath as string | null) ?? null;
					this.exitInfo = (payload.exitInfo as typeof this.exitInfo) ?? null;
					const pending = (payload.pendingUi as UiRequest[] | undefined) ?? [];
					this.pendingUi = pending;
					return;
				}
				case "preview": {
					const info = payload as unknown as PreviewInfo;
					const wasReady = this.previewInfo?.status.state === "ready";
					this.previewInfo = info;
					if (!this.previewUrl && info.status.port) this.previewUrl = `${info.proxyPrefix}/`;
					// A fresh upstream that just became ready: reload the frame once (no polling).
					if (info.status.state === "ready" && !wasReady) this.previewFrameKey++;
					return;
				}
				case "sessions": {
					this.sessions = (payload.items as SessionSummary[] | undefined) ?? [];
					this.currentSessionPath = (payload.current as string | null) ?? this.currentSessionPath;
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
			if (record.type === "response") {
				this.handleResponse(record);
				return;
			}
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
					// the system prompt is not a conversation message
					if (message?.role === "system") return;
					const role = message?.role === "user" ? "user" : "assistant";
					const id = String(message?.id ?? `m-${this.messages.length}-${Date.now()}`);
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
							// replace the streamed deltas with the authoritative content blocks
							current.blocks = messageToBlocks(message);
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
				case "bash_execution_update": {
					const delta = String(record.delta ?? "");
					if (delta) this.shellOutput += delta;
					return;
				}
				case "session_info_changed":
					this.send({ type: "get_state" });
					return;
				case "extension_ui_request": {
					const request = record as unknown as UiRequest & { statusText?: string; statusKey?: string; text?: string };
					if (!DIALOG_METHODS.has(request.method)) {
						// one-way status/notify records are not approvals
						this.status[request.statusKey ?? request.method] = String(request.statusText ?? request.text ?? "");
						return;
					}
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

		/** Responses to commands we sent (state, messages, session switching). */
		handleResponse(record: WireRecord): void {
			const command = String(record.command ?? "");
			const data = (record.data ?? {}) as Record<string, unknown>;
			if (record.success === false) {
				this.lastError = `${command} failed: ${JSON.stringify(record.error ?? data).slice(0, 300)}`;
				return;
			}
			switch (command) {
				case "get_state": {
					this.currentSessionPath = (data.sessionFile as string) ?? this.currentSessionPath;
					this.sessionName = (data.sessionName as string) ?? null;
					const model = data.model as { provider?: string; id?: string } | undefined;
					if (model) this.model = [model.provider, model.id].filter(Boolean).join("/");
					this.thinkingLevel = String(data.thinkingLevel ?? "");
					this.autoCompaction = typeof data.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : this.autoCompaction;
					this.steeringMode = String(data.steeringMode ?? this.steeringMode);
					this.followUpMode = String(data.followUpMode ?? this.followUpMode);
					return;
				}
				case "get_messages": {
					this.replaceMessages((data.messages as unknown[] | undefined) ?? []);
					return;
				}
				case "switch_session":
					if (data.cancelled) {
						this.lastError = "pi cancelled the session switch (an extension blocked it)";
						return;
					}
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
					this.send({ type: "list_sessions" });
					return;
				case "get_commands": {
					this.commands = (data.commands as CommandInfo[] | undefined) ?? [];
					return;
				}
				case "get_available_models": {
					this.models = (data.models as ModelInfo[] | undefined) ?? [];
					return;
				}
				case "get_available_thinking_levels": {
					const levels = (data.levels ?? data.thinkingLevels) as string[] | undefined;
					this.thinkingLevels = levels ?? [];
					return;
				}
				case "get_session_stats": {
					this.stats = data as SessionStats;
					return;
				}
				case "get_tree": {
					this.tree = (data.tree as unknown[] | undefined) ?? (Array.isArray(data) ? (data as unknown[]) : []);
					return;
				}
				case "get_fork_messages": {
					const points = (data.messages ?? data.forkMessages ?? data.entries) as ForkPoint[] | undefined;
					this.forkPoints = points ?? [];
					return;
				}
				case "get_last_assistant_text": {
					this.lastAssistantText = String(data.text ?? "");
					return;
				}
				case "export_html": {
					this.configStatus = `export_html: ${JSON.stringify(data)}`;
					return;
				}
				case "bash": {
					this.shellRunning = false;
					this.shellExitCode = typeof data.exitCode === "number" ? data.exitCode : null;
					// The response can be truncated; streaming already delivered the chunks.
					if (data.output && !this.shellOutput) this.shellOutput = String(data.output);
					return;
				}
				case "clone":
					if (data.cancelled) this.lastError = "pi cancelled the clone (an extension blocked it)";
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
					this.send({ type: "list_sessions" });
					return;
				case "fork": {
					if (data.cancelled) {
						this.lastError = "pi cancelled the fork (an extension blocked it)";
						return;
					}
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
					this.send({ type: "list_sessions" });
					return;
				}
				case "set_model":
				case "cycle_model":
				case "set_thinking_level":
				case "cycle_thinking_level":
				case "set_auto_compaction":
				case "set_auto_retry":
				case "set_steering_mode":
				case "set_follow_up_mode":
					this.send({ type: "get_state" });
					return;
				case "set_session_name":
					this.send({ type: "get_state" });
					this.send({ type: "list_sessions" });
					return;
				case "new_session":
					if (data.cancelled) this.lastError = "pi cancelled the new session (an extension blocked it)";
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
					this.send({ type: "list_sessions" });
					return;
				default:
					return;
			}
		},

		/** Replace the whole message list from an authoritative `get_messages` payload. */
		replaceMessages(messages: unknown[]): void {
			const rebuilt: ChatMessage[] = [];
			for (const [index, raw] of messages.entries()) {
				const message = raw as { role?: string; id?: string };
				if (message.role !== "user" && message.role !== "assistant") continue;
				rebuilt.push({ id: String(message.id ?? `h-${index}`), role: message.role, blocks: messageToBlocks(raw), done: true });
			}
			this.messages = rebuilt;
			this.tools = {};
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
		listSessions(): void {
			this.send({ type: "list_sessions" });
		},
		switchSession(path: string): void {
			if (path === this.currentSessionPath) return;
			this.send({ type: "switch_session", path });
		},
		renameSession(name: string): void {
			this.send({ type: "set_session_name", name });
		},
		compact(): void {
			this.send({ type: "compact" });
		},
		requestPreview(): void {
			this.send({ type: "preview_status" });
		},
		devStart(command?: string, port?: number): void {
			this.previewError = "";
			this.send({ type: "dev_start", command, port });
		},
		devStop(): void {
			this.send({ type: "dev_stop" });
		},

		/**
		 * Address bar → same-origin proxy path. Only the configured loopback dev server and
		 * read-only file paths are reachable; everything else is refused with the reason.
		 */
		navigate(input: string): string | null {
			const value = input.trim();
			if (!value) return null;
			const refuse = (why: string): null => {
				this.previewError = why;
				return null;
			};
			if (value.startsWith("/__proxy/") || value.startsWith("/__file/")) {
				this.previewError = "";
				this.previewUrl = value;
				return value;
			}
			if (value.startsWith("file://")) {
				const path = decodeURIComponent(value.slice("file://".length));
				if (!path.startsWith("/")) return refuse("refused: file:// needs an absolute path");
				this.previewError = "";
				this.previewUrl = `/__file/?path=${encodeURIComponent(path)}`;
				return this.previewUrl;
			}
			const status = this.previewInfo?.status;
			if (value.startsWith("/")) {
				this.previewError = "";
				this.previewUrl = `/__proxy${value}`;
				return this.previewUrl;
			}
			let url: URL | null = null;
			try {
				url = new URL(value);
			} catch {
				url = null;
			}
			if (!url || !url.hostname) return refuse(`refused: "${value}" is not a URL`);
			const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
			if (!loopback.has(url.hostname)) {
				return refuse(`refused: ${url.hostname} is not a loopback upstream (only the local dev server is proxied)`);
			}
			if (status?.port && url.port && url.port !== String(status.port)) {
				return refuse(`refused: port ${url.port} is not the dev server port ${status.port}`);
			}
			this.previewError = "";
			this.previewUrl = `/__proxy${url.pathname}${url.search}${url.hash}`;
			return this.previewUrl;
		},

		reloadPreview(): void {
			this.previewFrameKey++;
		},

		setPickMode(on: boolean): void {
			this.pickMode = on;
		},

		removePick(id: string): void {
			this.picks = this.picks.filter((pick) => pick.id !== id);
		},

		clearPicks(): void {
			this.picks = [];
		},

		setPickNote(id: string, note: string): void {
			this.picks = this.picks.map((pick) => (pick.id === id ? { ...pick, note } : pick));
		},

		/** Structured facts about one picked element — facts only, no instructions. */
		pickFacts(pick: PickRecord): string {
			const p = pick.payload;
			return [
				`[page] ${p.url}${p.title ? ` — ${p.title}` : ""}`,
				`[element] <${p.tag}>${p.role ? ` role=${p.role}` : ""}${p.id ? ` #${p.id}` : ""} selector=${p.selector} (matches ${p.selectorMatches}, unique ${p.selectorUnique ? "yes" : "no"})`,
				`[text] ${p.text || "(empty)"}`,
				`[rect] x=${p.rect.x} y=${p.rect.y} w=${p.rect.w} h=${p.rect.h}`,
				`[html] ${p.html}`,
				pick.note ? `[note] ${pick.note}` : "",
			]
				.filter(Boolean)
				.join("\n");
		},

		insertIntoPrompt(text: string): void {
			this.composerDraft = text;
			this.composerSeq++;
		},

		// ---- control surface -------------------------------------------------
		openControl(tab?: string): void {
			this.showControl = true;
			if (tab) this.controlTab = tab;
		},
		requestCommands(): void {
			this.send({ type: "get_commands" });
		},
		requestModels(): void {
			this.send({ type: "get_available_models" });
		},
		requestThinkingLevels(): void {
			this.send({ type: "get_available_thinking_levels" });
		},
		setModel(provider: string, modelId: string): void {
			this.send({ type: "set_model", provider, modelId });
		},
		cycleModel(): void {
			this.send({ type: "cycle_model" });
		},
		setThinking(level: string): void {
			this.send({ type: "set_thinking_level", level });
		},
		cycleThinking(): void {
			this.send({ type: "cycle_thinking_level" });
		},
		setAutoCompaction(enabled: boolean): void {
			this.autoCompaction = enabled;
			this.send({ type: "set_auto_compaction", enabled });
		},
		setAutoRetry(enabled: boolean): void {
			this.autoRetry = enabled;
			this.send({ type: "set_auto_retry", enabled });
		},
		setSteeringMode(mode: string): void {
			this.send({ type: "set_steering_mode", mode });
		},
		setFollowUpMode(mode: string): void {
			this.send({ type: "set_follow_up_mode", mode });
		},
		requestStats(): void {
			this.send({ type: "get_session_stats" });
		},
		requestTree(): void {
			this.send({ type: "get_tree" });
		},
		requestForkPoints(): void {
			this.send({ type: "get_fork_messages" });
		},
		forkFrom(entryId: string): void {
			this.send({ type: "fork", entryId });
		},
		cloneSession(): void {
			this.send({ type: "clone" });
		},
		exportHtml(path?: string): void {
			this.send(path ? { type: "export_html", outputPath: path } : { type: "export_html" });
		},
		copyLastAssistant(): void {
			this.send({ type: "get_last_assistant_text" });
		},
		/** A discoverable command runs by sending `/name` as a prompt (docs: get_commands). */
		insertCommand(name: string): void {
			this.insertIntoPrompt(`/${name} `);
			this.showControl = false;
		},
		runBash(): void {
			const command = this.shellCommand.trim();
			if (!command) return;
			this.shellOutput = "";
			this.shellExitCode = null;
			this.shellRunning = true;
			this.send({ type: "bash", command, excludeFromContext: this.shellExcluded });
		},
		abortBash(): void {
			this.send({ type: "abort_bash" });
		},
		loadConfigFiles(): void {
			void fetch("/api/config")
				.then((response) => response.json() as Promise<{ files: ConfigFile[] }>)
				.then((data) => {
					this.configFiles = data.files ?? [];
					if (!this.configName && this.configFiles.length) this.pickConfig(this.configFiles[0].name);
				})
				.catch((error: unknown) => {
					this.configStatus = `could not read config: ${String(error)}`;
				});
		},
		pickConfig(name: string): void {
			const file = this.configFiles.find((item) => item.name === name);
			this.configName = name;
			this.configDraft = file?.content ?? "";
			this.configStatus = "";
		},
		saveConfig(): void {
			this.configStatus = "saving…";
			void fetch("/api/config", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: this.configName, content: this.configDraft }),
			})
				.then((response) => response.json() as Promise<{ ok?: boolean; error?: string; backupPath?: string | null; bytes?: number; takesEffect?: string }>)
				.then((data) => {
					this.configStatus = data.ok
						? `written ${data.bytes} bytes${data.backupPath ? ` (previous kept at ${data.backupPath})` : ""} — ${data.takesEffect}`
						: `refused: ${data.error}`;
					if (data.ok) this.loadConfigFiles();
				})
				.catch((error: unknown) => {
					this.configStatus = `write failed: ${String(error)}`;
				});
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
