/** Wire types shared by the store and the components. */

export interface ToolRun {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	output: string;
	partial: string;
	/** `unknown` = we have no observable record (e.g. the run predates this page load). */
	status: "running" | "done" | "error" | "unknown";
	/** Absent for history: a reloaded conversation has no live timing to report. */
	startedAt?: number;
	endedAt?: number;
}

export type Block =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; toolCallId: string; toolName?: string; args?: unknown };

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	blocks: Block[];
	done: boolean;
	usage?: { input?: number; output?: number; cost?: number; totalTokens?: number };
}

export interface UiRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	timeout?: number;
}

export interface SessionSummary {
	path: string;
	id: string;
	name?: string;
	cwd?: string;
	createdAt?: string;
	updatedAt: string;
	sizeBytes: number;
	firstPrompt?: string;
	messageCount: number;
}

export type ConnState = "connecting" | "open" | "closed" | "error";

/** Flatten tool-result content (text/image parts) to text for display. */
export function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content, null, 2);
	return content
		.map((part) => {
			const block = part as { type?: string; text?: string };
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "image") return "[image]";
			return typeof part === "string" ? part : JSON.stringify(part);
		})
		.join("\n");
}

/**
 * Turn a completed pi message into display blocks.
 *
 * `content` mixes block kinds; only `text` is text. Thinking and tool calls get their own
 * blocks (they are rendered separately), so they must never be stringified into the text.
 */
export function messageToBlocks(message: unknown): Block[] {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const blocks: Block[] = [];
	for (const part of content) {
		const block = part as {
		type?: string;
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
		arguments?: unknown;
		toolCallId?: string;
		toolName?: string;
	};
		switch (block?.type) {
			case "text":
				if (block.text) blocks.push({ kind: "text", text: block.text });
				break;
			case "thinking":
				if (block.thinking) blocks.push({ kind: "thinking", text: block.thinking });
				break;
			case "toolCall":
			case "tool_call": {
				const toolCallId = block.toolCallId ?? block.id;
				// The name and the arguments are on the wire too; history has nothing else.
				const toolName = block.name ?? block.toolName;
				if (toolCallId) blocks.push({ kind: "tool", toolCallId, ...(toolName ? { toolName } : {}) , ...(block.arguments !== undefined ? { args: block.arguments } : {}) });
				break;
			}
			default:
				break; // unknown block kinds are not silently rendered as text
		}
	}
	return blocks;
}

/** Visible text of a message (user echoes) — thinking and tool calls excluded. */
export function messageToText(message: unknown): string {
	return messageToBlocks(message)
		.filter((block): block is { kind: "text"; text: string } => block.kind === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Preview side (same-origin proxy + dev server + element picking). */
export interface DevServerStatus {
	state: "stopped" | "starting" | "ready" | "failed" | "exited";
	command: string | null;
	port: number | null;
	pid: number | null;
	startedAt: number | null;
	readyAt: number | null;
	readyVia: string | null;
	httpStatus: number | null;
	error: string | null;
	log: string[];
	cwd: string;
}

export interface PreviewInfo {
	status: DevServerStatus;
	project: { command: string | null; port: number | null; readyPattern: string | null; configured: boolean };
	proxyPrefix: string;
	filePrefix: string;
}

/** What the injected picker reports about the element the user clicked. */
export interface PickPayload {
	url: string;
	title: string;
	tag: string;
	role: string | null;
	id: string | null;
	classes: string | null;
	text: string;
	rect: { x: number; y: number; w: number; h: number };
	selector: string;
	selectorMatches: number;
	selectorUnique: boolean;
	html: string;
}

export interface PickRecord {
	id: string;
	at: string;
	note: string;
	payload: PickPayload;
}

/** Control surface (everything the TUI can do, driven over RPC). */
export interface CommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill" | string;
	sourceInfo?: { path?: string; scope?: string; origin?: string };
}

export interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
	[key: string]: unknown;
}

export interface ConfigFile {
	name: string;
	path: string;
	exists: boolean;
	bytes: number;
	content: string;
	error?: string;
}

export interface SessionStats {
	sessionFile?: string;
	sessionId?: string;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	totalMessages?: number;
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	cost?: number;
	contextUsage?: { tokens?: number; percent?: number; [key: string]: unknown };
	[key: string]: unknown;
}

export interface ForkPoint {
	entryId: string;
	preview?: string;
	text?: string;
	timestamp?: number;
}

/** Workspaces (one pi child per directory; exactly one is the active writer). */
export interface WorkspaceInfo {
	path: string;
	active: boolean;
	exists: boolean;
	state: string;
	sessionPath: string | null;
	pendingUi: number;
	previewState: string;
	previewPort: number | null;
	isRepo: boolean;
}

/** File tree / folder picker. */
export interface DirEntry {
	name: string;
	path: string;
	type: "dir" | "file" | "symlink" | "other";
	size: number;
	mtimeMs: number;
	ignored?: boolean;
}

/** Git panel payloads (server/git.ts). */
export interface GitEntry {
	path: string;
	index: string;
	worktree: string;
	kind: "changed" | "renamed" | "unmerged" | "untracked" | "ignored";
	origPath?: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	conflicted: boolean;
}

export interface GitStatus {
	repo: boolean;
	root: string | null;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	entries: GitEntry[];
	error?: string;
}

export interface GitBranch {
	name: string;
	sha: string;
	date: string;
	upstream: string;
	remote: boolean;
}

export interface GitCommit {
	hash: string;
	short: string;
	author: string;
	date: string;
	subject: string;
	refs: string;
}

/**
 * Rebuild tool input/output from a conversation's history.
 *
 * A tool call is spread over two messages: the assistant message carries the call with its
 * arguments, and a following `toolResult` message carries the output. A reloaded page only has
 * these, so without this the cards would claim they know nothing — which is exactly what the
 * terminal never does.
 */
export function collectToolRuns(messages: unknown[]): Record<string, ToolRun> {
	const runs: Record<string, ToolRun> = {};
	const ensure = (toolCallId: string): ToolRun =>
		(runs[toolCallId] ??= {
			toolCallId,
			toolName: "tool",
			output: "",
			partial: "",
			// Until a result shows up we genuinely do not know how it ended.
			status: "unknown",
		});

	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
		if (message.role === "toolResult") {
			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (!toolCallId) continue;
			const run = ensure(toolCallId);
			if (typeof message.toolName === "string" && message.toolName) run.toolName = message.toolName;
			run.output = blocksToText(message.content);
			run.status = message.isError ? "error" : "done";
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const block = part as { type?: string; id?: string; toolCallId?: string; name?: string; arguments?: unknown };
			if (block?.type !== "toolCall" && block?.type !== "tool_call") continue;
			const toolCallId = block.toolCallId ?? block.id;
			if (!toolCallId) continue;
			const run = ensure(toolCallId);
			if (block.name) run.toolName = block.name;
			if (block.arguments !== undefined) run.args = block.arguments;
		}
	}
	return runs;
}

/**
 * One command in the shell drawer's scrollback — the same thing a terminal keeps: the command, its
 * output, and the facts about that output (exit code, truncation, what was dropped from the buffer).
 */
export interface ShellEntry {
	id: string;
	command: string;
	output: string;
	/** Characters dropped from the front of the buffer we keep (stated, never silent). */
	droppedChars: number;
	exitCode: number | null;
	running: boolean;
	cancelled: boolean;
	truncatedByPi: boolean;
	fullOutputPath: string;
	startedAt: number;
	endedAt?: number;
}
