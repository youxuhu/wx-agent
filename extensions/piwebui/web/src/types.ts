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

export type ConnState = "connecting" | "open" | "closed" | "error";

/** Content of pi's tool results is a list of content blocks; flatten to text for display. */
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

/** Pull message text out of a `message_end` message object. */
export function messageToText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	return blocksToText(content);
}
