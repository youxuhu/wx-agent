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
	collectToolRuns,
	messageToBlocks,
	messageToText,
	type ChatMessage,
	type CheckpointRow,
	type CommandInfo,
	type ConfigFile,
	type ConnState,
	type DirEntry,
	type GitBranch,
	type GitCommit,
	type GitStatus,
	type WorkspaceInfo,
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

/** Extension status/notify texts are colorized for the terminal; the browser must not show escapes. */
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI, "");

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
		/** The workspace the current hydration belongs to (so it runs once per folder). */
		hydratedFor: null as string | null,
		/** A row waiting for its second click (the deleting step). */
		sessionDeletePending: null as string | null,
		/** The restart control's armed state (two-step, so a stray click cannot stop a run). */
		restartPending: false,
		piState: "stopped" as string,
		clientId: "" as string,
		/** Which tab holds the pen for the active workspace (null = nobody has written yet). */
		writer: null as null | { holder: string | null; since: string | null },
		exitInfo: null as null | { code: number | null; signal: string | null; at: string },
		messages: [] as ChatMessage[],
		tools: {} as Record<string, ToolRun>,
		pendingUi: [] as UiRequest[],
		running: false,
		lastError: "" as string,
		lastErrorAt: "" as string,
		stderr: [] as string[],
		usage: null as null | { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number },
		contextUsage: null as null | { tokens: number | null; contextWindow: number | null; percent: number | null },
		notice: "" as string,
		speed: null as null | number,
		queueSteering: 0,
		queueFollowUp: 0,
		/**
		 * Queued messages we know about, with the kind pi confirmed. pi answers every prompt with how
		 * it took it (`disposition`), and a queued message is consumed when it shows up as a user
		 * message — so the count is derived from observed facts instead of guessing.
		 */
		queuedTexts: [] as Array<{ kind: "steer" | "followUp"; text: string }>,
		/** Prompts sent while a run was active, in order (pi answers them in the same order). */
		pendingPromptKinds: [] as Array<{ kind: "steer" | "followUp"; text: string }>,
		status: {} as Record<string, string>,
		sessions: [] as SessionSummary[],
		currentSessionPath: null as string | null,
		sessionName: null as string | null,
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
		drawer: "none" as "none" | "files" | "git" | "shell" | "preview" | "settings",
		/**
		 * Changes / History / Branches are one subject (git), so they are sub-tabs of a single
		 * drawer instead of three peers of Files and Settings in the top bar.
		 */
		gitTab: "changes" as "changes" | "history" | "branches",
		/** Settings has one subject per view instead of one long page. */
		settingsTab: "model" as "model" | "credentials" | "commands" | "session" | "checkpoints" | "config",
		/** Per-turn code checkpoints of the active workspace (read from the extension's index). */
		checkpoints: [] as CheckpointRow[],
		checkpointsNote: "" as string,
		checkpointsRepo: null as string | null,
		checkpointsWindow: 15,
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
		/**
		 * Terminal (PTY) output is queued, not overwritten: several chunks can arrive in one tick,
		 * and a watcher on a single string would drop all but the last one (a real data-loss bug for
		 * fast output like `ls -R` or a build log). The panel drains this queue.
		 */
		ptyQueue: [] as string[],
		/** Bumped on every chunk so the panel's watcher fires without watching the queue deeply. */
		ptyOutputSeq: 0,
		ptyRunning: false,
		ptyShell: "",
		/** Bumped when the service reports a terminal with no history to replay (a restart). */
		ptyFreshSeq: 0,
		ptyState: null as null | { replay: string; droppedChars: number; cols: number; rows: number },
		/** Text to place in a terminal as soon as it is up (typed, never executed for the user). */
		pendingLoginText: "" as string,
		authProviders: [] as Array<{ provider: string; kind: string; hasSecret: boolean; expires?: number }>,
		authNote: "",
		authStatus: "",
		authBusy: false,
		defaultModelStatus: "",
		pendingSends: [] as Record<string, unknown>[],
		reconnectAttempts: 0,
		pendingFile: "" as string,
		reconnectIn: null as number | null,

		// --- workspaces -------------------------------------------------------
		workspaces: [] as WorkspaceInfo[],
		activeWorkspace: null as string | null,
		recentWorkspaces: [] as string[],
		showFolderPicker: false,
		browsePath: "" as string,
		browseParent: null as string | null,
		browseEntries: [] as DirEntry[],
		browseRoots: [] as Array<{ path: string; label: string }>,
		browseError: "" as string,

		// --- drawer/sidebar view state -----------------------------------------
		sidebar: "files" as "files" | "changes" | "history" | "branches" | "none",
		treeChildren: {} as Record<string, DirEntry[]>,
		treeExpanded: [] as string[],
		fileView: null as null | { path: string; text: string; language: string | null; bytes: number; mtimeMs: number },
		/** Editing state: the draft is only sent on save, and the read's mtime/size guard the write. */
		fileEditing: false,
		fileDraft: "" as string,
		fileSaving: false,
		fileSaveError: "" as string,
		fileError: "",
		showIgnoredFiles: false,

		// --- git --------------------------------------------------------------
		gitStatus: null as GitStatus | null,
		gitDiff: null as null | { path: string; staged: boolean; text: string; ok: boolean; error?: string },
		gitLog: [] as GitCommit[],
		gitBranches: [] as GitBranch[],
		gitMessage: "" as string,
		gitAmend: false,
		gitBusy: false,
		gitNotice: "",
		gitShow: null as null | { ref: string; text: string },
		gitConfirm: null as null | { kind: "discard"; paths: string[] },
		speedSample: null as null | { output: number; at: number },
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
				this.reconnectAttempts = 0;
				this.reconnectIn = null;
				this.lastError = "";
				// Anything requested while the socket was still connecting goes out now.
				const queued = this.pendingSends;
				this.pendingSends = [];
				for (const message of queued) this.send(message);
				// The workspace list is the one thing that does not need a folder; everything else
				// is asked for once a folder is known (see hydrate()).
				this.send({ type: "list_workspaces" });
				this.hydrate();
			});
			socket.addEventListener("close", () => {
				this.conn = "closed";
				// A reconnected socket must hydrate again from scratch (nothing is replayed).
				this.hydratedFor = null;
				// Reconnect with backoff. Nothing is replayed: the socket reconnects, then the
				// client re-hydrates from the service, so no prompt or approval is re-sent.
				const delays = [1000, 2000, 4000, 8000, 15000];
				const attempt = this.reconnectAttempts ?? 0;
				this.reconnectAttempts = attempt + 1;
				const delay = delays[Math.min(attempt, delays.length - 1)];
				this.reconnectIn = Math.round(delay / 1000);
				window.setTimeout(() => {
					this.reconnectIn = null;
					this.connect();
				}, delay);
			});
			socket.addEventListener("error", () => {
				this.conn = "error";
				this.setError("websocket error");
			});
			socket.addEventListener("message", (event) => {
				let payload: { type?: string; [key: string]: unknown };
				try {
					payload = JSON.parse(String(event.data));
				} catch {
					this.setError("malformed message from service");
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
					this.setError(`refused an element pick from origin ${event.origin}`);
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
			this.setError("not connected to the local service");
		},

		handle(payload: { type?: string; [key: string]: unknown }): void {
			switch (payload.type) {
				case "workspaces": {
					const before = this.cwd;
					this.workspaces = (payload.workspaces as WorkspaceInfo[] | undefined) ?? [];
					this.activeWorkspace = (payload.active as string | null) ?? null;
					this.recentWorkspaces = (payload.recent as string[] | undefined) ?? [];
					this.cwd = this.activeWorkspace ?? this.cwd;
					// A newly opened folder has its own session and state to load.
					if (this.cwd !== before) {
						this.hydratedFor = null;
						this.hydrate();
					}
					return;
				}
				case "pty_data": {
					// Streamed as-is; xterm interprets the escape sequences (that is the point).
					this.ptyQueue.push(String(payload.data ?? ""));
					this.ptyOutputSeq += 1;
					return;
				}
				case "pty_state": {
					this.ptyRunning = payload.running === true;
					this.ptyShell = String(payload.shell ?? "");
					// `replay` empty + running means a *fresh* terminal: the panel must clear its screen
					// instead of leaving the dead one's text behind.
					this.ptyFreshSeq += payload.replay ? 0 : 1;
					if (this.pendingLoginText && this.ptyRunning) {
						// Typed, not executed: the user still decides when to press Enter (see startLoginTerminal).
						const text = this.pendingLoginText;
						this.pendingLoginText = "";
						this.send({ type: "pty_input", data: text });
					}
					this.ptyState = {
						replay: String(payload.replay ?? ""),
						droppedChars: Number(payload.droppedChars ?? 0),
						cols: Number(payload.cols ?? 100),
						rows: Number(payload.rows ?? 30),
					};
					return;
				}
				case "pty_exit": {
					this.ptyRunning = false;
					this.notice = `terminal exited (code ${String(payload.exitCode ?? "?")}${payload.signal ? `, signal ${String(payload.signal)}` : ""})`;
					return;
				}
				case "session_deleted": {
					this.notice = `deleted session file: ${String(payload.path ?? "")}`;
					return;
				}
				case "notice": {
					this.notice = String(payload.message ?? "");
					return;
				}
				case "hello": {
					this.cwd = String(payload.cwd ?? "");
					this.clientId = String(payload.clientId ?? "");
					this.writer = (payload.writer as typeof this.writer) ?? null;
					this.workspaces = (payload.workspaces as WorkspaceInfo[] | undefined) ?? [];
					this.activeWorkspace = (payload.active as string | null) ?? null;
					this.recentWorkspaces = (payload.recent as string[] | undefined) ?? [];
					if (this.activeWorkspace) this.cwd = this.activeWorkspace;
					this.hydrate();
					this.piState = String(payload.state ?? "unknown");
					this.currentSessionPath = (payload.currentSessionPath as string | null) ?? null;
					this.exitInfo = (payload.exitInfo as typeof this.exitInfo) ?? null;
					const pending = (payload.pendingUi as UiRequest[] | undefined) ?? [];
					this.pendingUi = pending;
					return;
				}
				case "rewind_sent": {
					// The command is with pi; the extension will ask for its own confirmation next.
					this.notice = `sent ${String(payload.command ?? "")} — the checkpoint extension asks for confirmation before it touches anything`;
					return;
				}
				case "pi_restarted": {
					// A new pi process: the old dialogs are gone, so the client must not keep showing them.
					this.pendingUi = [];
					const resumed = (payload.resumed as string | null) ?? null;
					const requested = (payload.requested as string | null) ?? null;
					const dropped = Number(payload.pendingApprovals ?? 0);
					const sameSession = Boolean(resumed) && resumed === requested;
					this.notice =
						"pi restarted (config and extensions reloaded) — " +
						(resumed
							? sameSession
								? "the same session was resumed"
								: `asked to resume ${requested ?? "no session"}, pi resumed ${resumed}`
							: "no session was active, so this is a fresh one") +
						(dropped ? `; ${dropped} pending approval(s) were dropped with the old process` : "");
					this.running = false;
					this.stderr = [];
					// Re-read everything that comes from the process.
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
					this.send({ type: "get_session_stats" });
					this.send({ type: "list_sessions" });
					this.send({ type: "get_commands" });
					return;
				}
				case "writer_state": {
					this.writer = { holder: (payload.holder as string | null) ?? null, since: (payload.since as string | null) ?? null };
					return;
				}
				case "writer_revoked": {
					// Another tab took the pen: say so instead of letting the next write fail mysteriously.
					this.writer = { holder: String(payload.by ?? "another tab"), since: null };
					this.notice = `tab ${String(payload.by ?? "another tab")} took over this workspace — this tab can still read; write again to take it back`;
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
					if (payload.error) this.setError(String(payload.error));
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
					this.setError(`pi sent a malformed record: ${String(payload.line ?? "").slice(0, 200)}`);
					return;
				case "error":
					this.setError(String(payload.message ?? "unknown error"));
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
					this.speed = null;
					this.speedSample = null;
					this.clearError();
					// A notice describes one moment ("queued as a follow-up"); a new run makes it stale.
					this.notice = "";
					return;
				case "agent_end":
				case "agent_settled":
					// The run is over: without this the composer stayed in "running" forever and every
					// later prompt was rejected by pi ("streaming, specify streamingBehavior").
					this.running = false;
					this.speedSample = null;
					this.notice = "";
					this.refreshContextUsage();
					return;
				case "compaction_end":
					this.refreshContextUsage();
					return;
				case "placeholder_agent_settled":
					this.running = false;
					for (const message of this.messages) message.done = true;
					return;
				case "message_start": {
					const message = record.message as { role?: string; id?: string } | undefined;
					// the system prompt is not a conversation message
					if (message?.role === "system") return;
					const role = message?.role === "user" ? "user" : "assistant";
					const id = String(message?.id ?? `m-${this.messages.length}-${Date.now()}`);
					const text = role === "user" ? messageToText(message) : "";
					this.messages.push({ id, role, blocks: role === "user" ? [{ kind: "text", text }] : [], done: role === "user" });
					// A queued message appearing as a real message means pi consumed it: stop counting it.
					if (role === "user") {
						const index = this.queuedTexts.findIndex((entry) => entry.text === text);
						if (index >= 0) {
							const [delivered] = this.queuedTexts.splice(index, 1);
							if (delivered.kind === "steer") this.queueSteering = Math.max(0, this.queueSteering - 1);
							else this.queueFollowUp = Math.max(0, this.queueFollowUp - 1);
						}
					}
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
							this.setError(`${message.errorMessage ?? message.stopReason ?? "model error"}`);
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
						const result = record.result as { content?: unknown; structuredContent?: unknown } | undefined;
						run.output = blocksToText(result?.content ?? result);
						// Some tools report only structured data; do not show an empty card for it.
						if (!run.output && result?.structuredContent !== undefined) run.output = blocksToText(result.structuredContent);
						run.status = record.isError ? "error" : "done";
						run.endedAt = Date.now();
					}
					return;
				}
				case "queue_update": {
					// Authoritative when it arrives (pi sends it as the queue drains): it lists what is
					// still queued, so the derived count is corrected rather than trusted forever.
					const steering = Array.isArray(record.steering) ? (record.steering as string[]) : [];
					const followUp = Array.isArray(record.followUp) ? (record.followUp as string[]) : [];
					this.queueSteering = steering.length;
					this.queueFollowUp = followUp.length;
					this.queuedTexts = [
						...steering.map((text) => ({ kind: "steer" as const, text })),
						...followUp.map((text) => ({ kind: "followUp" as const, text })),
					];
					return;
				}
				case "auto_retry_start":
					this.retry = { attempt: Number(record.attempt ?? 0), max: Number(record.maxAttempts ?? 0), reason: String(record.errorMessage ?? "") };
					return;
				case "auto_retry_end":
					this.retry = null;
					if (record.success === false) this.setError(`retries exhausted: ${String(record.finalError ?? "")}`);
					return;
				case "session_info_changed":
					this.send({ type: "get_state" });
					return;
				case "extension_ui_request": {
					const request = record as unknown as UiRequest & { statusText?: string; statusKey?: string; text?: string };
					if (!DIALOG_METHODS.has(request.method)) {
						// one-way status/notify records are not approvals
						this.status[request.statusKey ?? request.method] = stripAnsi(String(request.statusText ?? request.text ?? ""));
						return;
					}
					if (!this.pendingUi.some((item) => item.id === request.id)) this.pendingUi.push(request);
					return;
				}
				case "extension_error":
					this.setError(`extension error: ${String(record.error ?? record.message ?? "").slice(0, 300)}`);
					return;
				case "usage":
				case "turn_end": {
					const usage = (record.usage ?? (record as { message?: { usage?: unknown } }).message?.usage) as
						| {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								totalTokens?: number;
								cost?: { total?: number };
						  }
						| undefined;
					if (usage) {
						const output = usage.output ?? 0;
						this.usage = {
							input: usage.input ?? 0,
							output,
							cacheRead: usage.cacheRead ?? 0,
							cacheWrite: usage.cacheWrite ?? 0,
							totalTokens: usage.totalTokens ?? 0,
							cost: usage.cost?.total ?? 0,
						};
						this.trackSpeed(output);
					}
					if (record.type === "turn_end") this.refreshContextUsage();
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
				this.setError(`${command} failed: ${JSON.stringify(record.error ?? data).slice(0, 300)}`);
				return;
			}
				switch (command) {
					case "prompt": {
						// pi reports how it took each prompt: `started` (a turn) or `queued` (behind the run).
						// Responses arrive in send order, so the queue we expected lines up with them.
						const expected = this.pendingPromptKinds.shift();
						const disposition = String(data.disposition ?? "");
						if (!expected || disposition !== "queued") return;
						this.queuedTexts.push(expected);
						if (expected.kind === "steer") this.queueSteering++;
						else this.queueFollowUp++;
						return;
					}
					case "get_state": {
					this.currentSessionPath = (data.sessionFile as string) ?? this.currentSessionPath;
					this.sessionName = (data.sessionName as string) ?? null;
					const model = data.model as { provider?: string; id?: string } | undefined;
					if (model) this.model = [model.provider, model.id].filter(Boolean).join("/");
					this.thinkingLevel = String(data.thinkingLevel ?? "");
					this.autoCompaction = typeof data.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : this.autoCompaction;
					this.steeringMode = String(data.steeringMode ?? this.steeringMode);
					this.followUpMode = String(data.followUpMode ?? this.followUpMode);
					// Reconcile: the authoritative flag, so a missed event cannot wedge the composer.
					if (typeof data.isStreaming === "boolean") this.running = data.isStreaming;
					// A tool run we can no longer observe must not keep claiming it is running
					// (e.g. the page reloaded while a run was alive, or the child was restarted).
					if (!this.running) {
						for (const run of Object.values(this.tools)) {
							if (run.status === "running") run.status = "unknown";
						}
					}
					return;
				}
				case "get_messages": {
					this.replaceMessages((data.messages as unknown[] | undefined) ?? []);
					return;
				}
				case "switch_session":
					if (data.cancelled) {
						this.setError("pi cancelled the session switch (an extension blocked it)");
						return;
					}
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
				this.send({ type: "get_commands" });
				this.send({ type: "list_workspaces" });
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
				case "clear_queue": {
					const steering = (data.steering as string[] | undefined) ?? [];
					const followUp = (data.followUp as string[] | undefined) ?? [];
					const recovered = [...steering, ...followUp];
					this.queueSteering = 0;
					this.queueFollowUp = 0;
					this.queuedTexts = [];
					if (!recovered.length) {
						this.notice = "clear_queue: nothing was queued";
						return;
					}
					// TUI parity: the queued text goes back into the editor rather than disappearing.
					const text = recovered.join("\n");
					this.insertIntoPrompt(this.composerDraft.trim() ? `${text}\n${this.composerDraft}` : text);
					this.notice = `took back ${recovered.length} queued message${recovered.length === 1 ? "" : "s"} — the text is back in the input`;
					return;
				}
				case "get_session_stats": {
					this.stats = data as SessionStats;
					const context = (data.contextUsage ?? null) as { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | null;
					this.contextUsage = context
						? { tokens: context.tokens ?? null, contextWindow: context.contextWindow ?? null, percent: context.percent ?? null }
						: { tokens: null, contextWindow: null, percent: null };
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
				case "clone":
					if (data.cancelled) this.setError("pi cancelled the clone (an extension blocked it)");
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
				this.send({ type: "get_commands" });
				this.send({ type: "list_workspaces" });
					this.send({ type: "list_sessions" });
					return;
				case "fork": {
					if (data.cancelled) {
						this.setError("pi cancelled the fork (an extension blocked it)");
						return;
					}
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
				this.send({ type: "get_commands" });
				this.send({ type: "list_workspaces" });
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
					if (data.cancelled) this.setError("pi cancelled the new session (an extension blocked it)");
					this.send({ type: "get_state" });
					this.send({ type: "get_messages" });
				this.send({ type: "get_commands" });
				this.send({ type: "list_workspaces" });
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
				// A tool result is not a row of its own: it belongs to the card of the call it answers
				// (collectToolRuns below attaches it), exactly like the terminal shows it.
				if (message.role !== "user" && message.role !== "assistant") continue;
				rebuilt.push({ id: String(message.id ?? `h-${index}`), role: message.role, blocks: messageToBlocks(raw), done: true });
			}
			this.messages = rebuilt;
			// Input and output both live in the history; a run still in flight keeps its live record.
			const live = Object.fromEntries(Object.entries(this.tools).filter(([, run]) => run.status === "running"));
			this.tools = { ...collectToolRuns(messages), ...live };
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
		/**
		 * Hydrate everything that belongs to a workspace (session, messages, stats, preview,
		 * commands). Runs once per folder, on connect and whenever the active folder changes; with
		 * no folder open there is nothing to ask for, and asking anyway would surface a spurious
		 * "no workspace is open yet" error on a fresh install.
		 */
		hydrate(): void {
			if (!this.cwd || this.hydratedFor === this.cwd) return;
			this.hydratedFor = this.cwd;
			this.send({ type: "get_state" });
			this.send({ type: "list_sessions" });
			this.send({ type: "preview_status" });
			this.send({ type: "get_session_stats" });
			// a reload must not lose the conversation: ask for the current messages
			this.send({ type: "get_messages" });
			this.send({ type: "get_commands" });
		},

		/** Dismiss the current notice (it is a transient statement, not a state). */
		clearNotice(): void {
			this.notice = "";
		},

		/**
		 * Delete a session file. Destructive, so it takes two steps (`confirmDeleteSession` then
		 * `deleteSession`) and the service re-checks the guards: the path must be a session file of
		 * this workspace and must not be the one that is currently open.
		 */
		confirmDeleteSession(path: string | null): void {
			this.sessionDeletePending = path;
		},
		deleteSession(path: string): void {
			this.sessionDeletePending = null;
			this.send({ type: "delete_session", path, confirmed: true });
		},

		/** Switch a settings view, loading whatever that view needs. */
		setSettingsTab(tab: "model" | "credentials" | "commands" | "session" | "checkpoints" | "config"): void {
			this.settingsTab = tab;
			if (tab === "model" && !this.models.length) this.requestModels();
			if (tab === "commands" && !this.commands.length) this.requestCommands();
			if (tab === "credentials") this.loadAuth();
			if (tab === "session") this.listSessions();
			if (tab === "checkpoints") this.loadCheckpoints();
			if (tab === "config" && !this.configFiles.length) this.loadConfigFiles();
		},

		/** Per-turn code checkpoints (read-only listing; the extension performs the rewind). */
		loadCheckpoints(): void {
			void fetch(`/api/checkpoints?ws=${encodeURIComponent(this.cwd)}`)
				.then((response) => (response.ok ? response.json() : response.text().then((text) => Promise.reject(new Error(text)))))
				.then((payload: { rows?: CheckpointRow[]; note?: string; repo?: string | null; window?: number }) => {
					this.checkpoints = payload.rows ?? [];
					this.checkpointsNote = payload.note ?? "";
					this.checkpointsRepo = payload.repo ?? null;
					this.checkpointsWindow = payload.window ?? 15;
				})
				.catch((error: unknown) => {
					this.checkpoints = [];
					this.checkpointsNote = `could not read the checkpoint index: ${error instanceof Error ? error.message : String(error)}`;
				});
		},

		/**
		 * Ask for a rewind. The extension owns the restore and asks for its own confirmation, which
		 * arrives as a dialog here — so this sends exactly the command the TUI would receive.
		 */
		rewind(index: number, tree = false): void {
			if (this.running) {
				this.setError("a run is active: rewind changes the working tree under it — wait for it to finish, then try again");
				return;
			}
			this.send({ type: "rewind", index, tree });
		},

		/** Switch the git sub-tab and load whatever that view needs (the panels do not self-load). */
		setGitTab(tab: "changes" | "history" | "branches"): void {
			this.gitTab = tab;
			if (tab === "changes") this.refreshGit();
			if (tab === "history") this.loadLog();
			if (tab === "branches") this.loadBranches();
		},

		/** Restart pi in place (`/reload`): config and extensions are re-read, the session is resumed. */
		reloadPi(confirmed = false): void {
			this.send({ type: "reload_pi", confirmed });
		},
		/**
		 * `/login` is a TUI command: it does not exist in RPC mode and sending it as a prompt only
		 * talks to the model (measured — see the README). So the browser hands over a real terminal
		 * instead of pretending it can drive the flow: open the Shell drawer, start the terminal if
		 * needed, and type `pi` for the user to confirm. The login then runs in that terminal.
		 */
		startLoginTerminal(): void {
			this.drawer = "shell";
			this.notice = "in this terminal: press Enter to start pi, then run /login <provider>; the credential is written by pi itself";
			if (this.ptyRunning) {
				this.send({ type: "pty_input", data: "pi" });
				return;
			}
			this.pendingLoginText = "pi";
			// The Shell panel starts the terminal with its real dimensions; the text follows its state.
		},

		/** Take the pen for this tab (explicit: the server never steals it silently). */
		claimWriter(force = false): void {
			this.send({ type: "claim_writer", force });
		},
		sendPrompt(text: string): void {
			if (!text.trim()) return;
			this.notice = "";
			this.clearError();
			this.notifyIfBuiltinCommand(text);
			if (this.running) {
				// pi rejects a plain prompt while streaming; queue it behind the current run and say so.
				this.notice = "a run is still active — this message was queued as a follow-up";
				this.pendingPromptKinds.push({ kind: "followUp", text });
				this.send({ type: "prompt", message: text, streamingBehavior: "followUp" });
				return;
			}
			this.send({ type: "prompt", message: text });
		},
		steer(text: string): void {
			this.clearError();
			this.pendingPromptKinds.push({ kind: "steer", text });
			this.send({ type: "steer", message: text });
		},
		abort(): void {
			this.send({ type: "abort" });
			// An abort is the user's recovery move: do not leave a stale error or a stuck flag.
			this.clearError();
			this.notice = "";
			this.send({ type: "get_state" });
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
		/** Output tokens per second between consecutive usage reports of a run. */
		trackSpeed(output: number): void {
			const now = performance.now();
			if (!this.speedSample) {
				this.speedSample = { output, at: now };
				return;
			}
			const seconds = (now - this.speedSample.at) / 1000;
			const delta = output - this.speedSample.output;
			if (seconds < 0.4 || delta <= 0) return;
			const sample = delta / seconds;
			// light smoothing so the number does not jump between deltas
			this.speed = this.speed === null ? sample : this.speed * 0.6 + sample * 0.4;
			this.speedSample = { output, at: now };
		},

		refreshContextUsage(): void {
			this.send({ type: "get_session_stats" });
		},

		// ---- workspaces ------------------------------------------------------
		loadWorkspacesOnce(): void {
			void fetch("/api/workspaces")
				.then((response) => response.json())
				.then((data: { active?: string | null; recent?: string[]; workspaces?: WorkspaceInfo[] }) => {
					this.workspaces = data.workspaces ?? [];
					this.activeWorkspace = data.active ?? null;
					this.recentWorkspaces = data.recent ?? [];
					if (this.activeWorkspace) this.cwd = this.activeWorkspace;
				})
				.catch(() => undefined);
		},
		refreshWorkspaces(): void {
			this.send({ type: "list_workspaces" });
		},
		openFolder(path: string, activate = true): void {
			this.send({ type: "open_workspace", path, activate });
			if (activate) this.switchWorkspace(path);
			this.showFolderPicker = false;
		},
		switchWorkspace(path: string): void {
			this.send({ type: "switch_workspace", path });
			// Per-workspace views are dropped; the service re-hydrates what it owns.
			this.previewUrl = "";
			this.picks = [];
			this.treeChildren = {};
			this.treeExpanded = [];
			this.fileView = null;
			this.fileError = "";
			this.gitStatus = null;
			this.gitDiff = null;
			this.gitLog = [];
			this.gitShow = null;
			this.gitNotice = "";
			this.messages = [];
			this.tools = {};
		},
		closeWorkspace(path: string): void {
			this.send({ type: "close_workspace", path });
		},
		openFolderPicker(): void {
			this.showFolderPicker = true;
			this.browseError = "";
			if (!this.browsePath) this.browseTo("");
		},
		browseTo(path: string): void {
			void fetch(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`)
				.then((response) => response.json())
				.then((data: { path?: string; parent?: string | null; entries?: DirEntry[]; roots?: Array<{ path: string; label: string }>; error?: string } | string) => {
					if (typeof data === "string" || data.error) {
						this.browseError = typeof data === "string" ? data : String(data.error);
						return;
					}
					this.browsePath = data.path ?? "";
					this.browseParent = data.parent ?? null;
					this.browseEntries = data.entries ?? [];
					this.browseRoots = data.roots ?? [];
				})
				.catch((error: unknown) => {
					this.browseError = String(error);
				});
		},

		// ---- drawer entry points ---------------------------------------------
		/** Files and the git sub-tabs have their own loaders; opening the drawer must fill it. */
		openSidebar(tab: "files" | "changes" | "history" | "branches"): void {
			const opensGit = tab !== "files";
			if (opensGit) this.gitTab = tab;
			const target = opensGit ? "git" : "files";
			this.drawer = this.drawer === target ? "none" : target;
			if (this.drawer === "files") this.ensureTree(this.cwd);
			if (this.drawer === "git") {
				this.refreshGit();
				if (this.gitTab === "history") this.loadLog();
				if (this.gitTab === "branches") this.loadBranches();
			}
		},
		ensureTree(dir: string): void {
			if (this.treeChildren[dir]) return;
			this.loadTree(dir);
		},
		loadTree(dir: string): void {
			// The workspace path may not have arrived yet; a request without it would be refused.
			if (!dir) return;
			const query = `?dir=${encodeURIComponent(dir)}${this.showIgnoredFiles ? "&showIgnored=1" : ""}`;
			void fetch(`/api/tree${query}`)
				.then((response) => response.json())
				.then((data: { dir?: string; root?: string; entries?: DirEntry[]; error?: string }) => {
					if (data.error) {
						this.fileError = String(data.error);
						return;
					}
					this.treeChildren = { ...this.treeChildren, [data.dir ?? dir]: data.entries ?? [] };
				})
				.catch((error: unknown) => {
					this.fileError = String(error);
				});
		},
		reloadTree(): void {
			this.treeChildren = {};
			this.loadTree(this.cwd);
		},
		toggleDir(dir: string): void {
			if (this.treeExpanded.includes(dir)) {
				this.treeExpanded = this.treeExpanded.filter((path) => path !== dir);
			} else {
				this.treeExpanded = [...this.treeExpanded, dir];
				this.ensureTree(dir);
			}
		},
		openFileAt(path: string): void {
			this.fileError = "";
			this.fileView = null;
			this.fileEditing = false;
			this.fileDraft = "";
			this.pendingFile = path;
			void fetch(`/api/file?path=${encodeURIComponent(path)}`)
				.then((response) => response.json())
				.then((data: { path?: string; text?: string; language?: string | null; bytes?: number; mtimeMs?: number; error?: string }) => {
					if (data.error) {
						this.fileError = String(data.error);
						return;
					}
					this.fileView = {
						path: data.path ?? path,
						text: data.text ?? "",
						language: data.language ?? null,
						bytes: data.bytes ?? 0,
						mtimeMs: data.mtimeMs ?? 0,
					};
					this.pendingFile = "";
				})
				.catch((error: unknown) => {
					this.fileError = String(error);
				});
		},

		/**
		 * Save the editor. The read's mtime/size go along, so a file that changed on disk is refused
		 * (409) rather than overwritten — the caller then offers "reload from disk", never a merge.
		 */
		saveFile(): void {
			const view = this.fileView;
			if (!view || !this.fileEditing) return;
			this.fileSaving = true;
			this.fileSaveError = "";
			void fetch(`/api/file?path=${encodeURIComponent(view.path)}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: this.fileDraft, expectedMtimeMs: view.mtimeMs, expectedSize: view.bytes }),
			})
				.then(async (response) => ({ ok: response.ok, body: (await response.json()) as { error?: string; bytes?: number; mtimeMs?: number } }))
				.then((result) => {
					this.fileSaving = false;
					if (!result.ok) {
						this.fileSaveError = result.body.error ?? "the write was refused";
						return;
					}
					const bytes = result.body.bytes ?? 0;
					const lines = this.fileDraft.split("\n").length;
					this.fileView = { ...view, text: this.fileDraft, bytes, mtimeMs: result.body.mtimeMs ?? view.mtimeMs };
					this.fileEditing = false;
					this.notice = `wrote ${view.path} — ${bytes} bytes, ${lines} line(s), mtime ${new Date(result.body.mtimeMs ?? Date.now()).toISOString()}`;
					// The tree and git status may legitimately change after a write.
					this.refreshGit();
				})
				.catch((error: unknown) => {
					this.fileSaving = false;
					this.fileSaveError = String(error);
				});
		},

		/** Discard the editor and re-read the file (the only offer after a 409 — no merging). */
		reloadFile(): void {
			const path = this.fileView?.path;
			this.fileEditing = false;
			this.fileSaveError = "";
			if (path) this.openFileAt(path);
		},

		// ---- git -------------------------------------------------------------
		refreshGit(): void {
			this.gitBusy = true;
			void Promise.all([
				fetch("/api/git/status").then((response) => response.json()),
				fetch("/api/git/branches").then((response) => response.json()),
			])
				.then(([status, branches]: [GitStatus, { branches?: GitBranch[] }]) => {
					this.gitStatus = status;
					this.gitBranches = branches.branches ?? [];
					this.gitBusy = false;
				})
				.catch((error: unknown) => {
					this.gitBusy = false;
					this.gitNotice = `git status failed: ${String(error)}`;
				});
		},
		loadDiff(path: string, staged: boolean): void {
			void fetch(`/api/git/diff?path=${encodeURIComponent(path)}${staged ? "&staged=1" : ""}`)
				.then((response) => response.json())
				.then((data: { ok?: boolean; stdout?: string; stderr?: string }) => {
					this.gitDiff = { path, staged, text: data.stdout ?? "", ok: data.ok === true, error: data.ok ? undefined : data.stderr };
				})
				.catch((error: unknown) => {
					this.gitDiff = { path, staged, text: "", ok: false, error: String(error) };
				});
		},
		gitAction(action: string, body: Record<string, unknown>): void {
			this.gitBusy = true;
			this.gitNotice = "";
			void fetch(`/api/git/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
				.then((response) => response.json())
				.then((result: { ok?: boolean; verbatim?: string; snapshot?: { detail?: string } }) => {
					this.gitBusy = false;
					const detail = [result.verbatim, result.snapshot?.detail].filter(Boolean).join(" · ");
					this.gitNotice = `${action}: ${result.ok ? "ok" : "refused"} — ${detail}`;
					if (result.ok && action === "commit") this.gitMessage = "";
					this.refreshGit();
					this.loadLog();
					if (this.gitDiff) this.loadDiff(this.gitDiff.path, this.gitDiff.staged);
				})
				.catch((error: unknown) => {
					this.gitBusy = false;
					this.gitNotice = `${action} failed: ${String(error)}`;
				});
		},
		stagePaths(paths: string[]): void {
			this.gitAction("stage", { paths });
		},
		unstagePaths(paths: string[]): void {
			this.gitAction("unstage", { paths });
		},
		/** Discard is destructive: it needs a confirmation step, and the service snapshots first. */
		requestDiscard(paths: string[]): void {
			this.gitConfirm = { kind: "discard", paths };
		},
		confirmDiscard(): void {
			const paths = this.gitConfirm?.paths ?? [];
			this.gitConfirm = null;
			this.gitAction("discard", { paths, confirmed: true });
		},
		commitGit(): void {
			this.gitAction("commit", { message: this.gitMessage, amend: this.gitAmend });
		},
		checkoutBranch(branch: string): void {
			this.gitAction("checkout", { branch });
		},
		createGitBranch(name: string): void {
			this.gitAction("branch", { name });
		},
		loadLog(): void {
			void fetch("/api/git/log?limit=100")
				.then((response) => response.json())
				.then((data: { commits?: GitCommit[] }) => {
					this.gitLog = data.commits ?? [];
				})
				.catch(() => undefined);
		},
		loadBranches(): void {
			void fetch("/api/git/branches")
				.then((response) => response.json())
				.then((data: { branches?: GitBranch[] }) => {
					this.gitBranches = data.branches ?? [];
				})
				.catch(() => undefined);
		},
		showCommit(ref: string): void {
			void fetch(`/api/git/show?ref=${encodeURIComponent(ref)}`)
				.then((response) => response.json())
				.then((data: { ok?: boolean; stdout?: string; stderr?: string }) => {
					this.gitShow = { ref, text: data.ok ? (data.stdout ?? "") : `failed: ${data.stderr ?? "unknown"}` };
				})
				.catch((error: unknown) => {
					this.gitShow = { ref, text: `failed: ${String(error)}` };
				});
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
			this.drawer = "settings";
			this.showControl = true;
			if (tab) this.controlTab = tab;
		},
		/**
		 * Built-in TUI commands (`/model`, `/settings`, …) are not in pi's discoverable
		 * command list and are not executed over RPC — they would be delivered to the model
		 * as plain text. Say so instead of letting it look like a command ran.
		 */
		notifyIfBuiltinCommand(text: string): void {
			const match = text.trim().match(/^\/([A-Za-z0-9:._-]+)/);
			if (!match) return;
			const name = match[1];
			if (this.commands.some((command) => command.name === name)) return;
			if (!this.commands.length) {
				this.notice = `"/${name}" is not in pi's command list yet (not loaded) — discoverable commands run by sending them; built-in TUI-only commands cannot run over RPC.`;
				return;
			}
			this.notice = `"/${name}" is not a discoverable command, so it was sent to the model as plain text. Built-in TUI-only commands (/model, /settings, /hotkeys, /login, /reload, …) have no RPC path — use the control drawer for model/thinking/session and the terminal for /reload.`;
		},

		// ---- credentials ------------------------------------------------------
		loadAuth(): void {
			void fetch("/api/auth")
				.then((response) => response.json())
				.then((data: { providers?: Array<{ provider: string; kind: string; hasSecret: boolean; expires?: number }>; note?: string }) => {
					this.authProviders = data.providers ?? [];
					this.authNote = data.note ?? "";
				})
				.catch((error: unknown) => {
					this.authStatus = `could not read credentials: ${String(error)}`;
				});
		},
		saveApiKey(provider: string, key: string): void {
			this.authBusy = true;
			this.authStatus = "";
			void fetch("/api/auth", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, key }) })
				.then((response) => response.json())
				.then((result: { ok?: boolean; verbatim?: string }) => {
					this.authBusy = false;
					this.authStatus = result.ok ? `saved a key for ${provider} (value not echoed back)` : result.verbatim ?? "failed";
					this.loadAuth();
				})
				.catch((error: unknown) => {
					this.authBusy = false;
					this.authStatus = `save failed: ${String(error)}`;
				});
		},
		removeCredential(provider: string): void {
			this.authBusy = true;
			void fetch(`/api/auth?provider=${encodeURIComponent(provider)}&confirmed=1`, { method: "DELETE" })
				.then((response) => response.json())
				.then((result: { ok?: boolean; verbatim?: string }) => {
					this.authBusy = false;
					this.authStatus = result.ok ? `removed the stored credential for ${provider}` : result.verbatim ?? "failed";
					this.loadAuth();
				})
				.catch((error: unknown) => {
					this.authBusy = false;
					this.authStatus = `remove failed: ${String(error)}`;
				});
		},
		/** settings.json holds the defaults; patch just those two fields. */
		applyDefaultModel(provider: string, model: string): void {
			void fetch("/api/config")
				.then((response) => response.json())
				.then(async (config: { files?: Array<{ name: string; content: string }> }) => {
					const file = config.files?.find((entry) => entry.name === "settings.json");
					if (!file) throw new Error("settings.json is not readable");
					const parsed = JSON.parse(file.content) as Record<string, unknown>;
					if (provider.trim()) parsed.defaultProvider = provider.trim();
					if (model.trim()) parsed.defaultModel = model.trim();
					const write = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "settings.json", content: `${JSON.stringify(parsed, null, 2)}
` }) });
					const result = (await write.json()) as { ok?: boolean; error?: string };
					this.defaultModelStatus = result.ok
						? `settings.json updated (defaults: ${parsed.defaultProvider ?? "-"} / ${parsed.defaultModel ?? "-"}) — new sessions use it, /reload applies the rest`
						: `refused: ${result.error}`;
					this.loadConfigFiles();
				})
				.catch((error: unknown) => {
					this.defaultModelStatus = `failed: ${String(error)}`;
				});
		},

		/** Errors are shown until they are dismissed or something works again. */
		setError(message: string): void {
			if (!message) return;
			this.lastError = message;
			this.lastErrorAt = new Date().toLocaleTimeString();
			// Whatever went wrong, re-sync the run state so the next attempt is not blocked by a
			// stale "running" flag.
			this.send({ type: "get_state" });
		},
		clearError(): void {
			this.lastError = "";
			this.lastErrorAt = "";
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
		/** Takes back queued steering/follow-up messages; their text returns to the input. */
		clearQueue(): void {
			this.send({ type: "clear_queue" });
		},
		insertCommand(name: string): void {
			this.insertIntoPrompt(`/${name} `);
			this.showControl = false;
		},
		// ---- terminal (PTY) ----
		/** Take everything the terminal produced since the last call (never drops a chunk). */
		drainPty(): string[] {
			if (!this.ptyQueue.length) return [];
			const chunks = this.ptyQueue;
			this.ptyQueue = [];
			return chunks;
		},

		/** Ask the service for this workspace's terminal; it replies with the current state. */
		startPty(cols: number, rows: number): void {
			if (!this.cwd) return;
			this.send({ type: "pty_start", cols, rows });
		},
		writePty(data: string): void {
			if (!data) return;
			this.send({ type: "pty_input", data });
		},
		resizePty(cols: number, rows: number): void {
			if (!this.cwd) return;
			this.send({ type: "pty_resize", cols, rows });
		},
		killPty(): void {
			this.send({ type: "pty_kill" });
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
