/** Wire types shared by the store and the components. */

export interface ToolRun {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	output: string;
	partial: string;
	status: "running" | "done" | "error";
	startedAt: number;
	endedAt?: number;
}

export type Block =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; toolCallId: string };

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
		const block = part as { type?: string; text?: string; thinking?: string; id?: string; toolCallId?: string };
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
				if (toolCallId) blocks.push({ kind: "tool", toolCallId });
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
