/**
 * Message rendering regression ("只看到 You/pi，没有内容"): the block discriminator is `kind`,
 * and every real payload shape pi sends must produce visible blocks.
 *
 * Fixtures are captured from a live `get_messages` response.
 */
import { messageToBlocks, messageToText } from "../web/src/types.ts";

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const user = { role: "user", content: [{ type: "text", text: "reply with exactly: life-three" }], timestamp: 1 };
const assistant = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "considering the request" },
		{ type: "text", text: "life-three" },
		{ type: "toolCall", id: "call_1", name: "bash", arguments: {} },
	],
	timestamp: 2,
};

const userBlocks = messageToBlocks(user);
check("a user message yields a text block", userBlocks.length === 1 && userBlocks[0].kind === "text" && userBlocks[0].text.includes("life-three"), JSON.stringify(userBlocks));
check("block discriminator is `kind` (a `type` template check would match nothing)", "kind" in userBlocks[0] && !("type" in userBlocks[0]), Object.keys(userBlocks[0]).join(","));

const assistantBlocks = messageToBlocks(assistant);
check("thinking becomes its own block", assistantBlocks.some((block) => block.kind === "thinking"), assistantBlocks.map((b) => b.kind).join(","));
check("text becomes a text block", assistantBlocks.some((block) => block.kind === "text" && block.text === "life-three"));
check(
	"a tool call maps to its toolCallId",
	assistantBlocks.some((block) => block.kind === "tool" && block.toolCallId === "call_1"),
	JSON.stringify(assistantBlocks.find((block) => block.kind === "tool")),
);
check(
	"the tool name travels with the block (history can show a real name)",
	assistantBlocks.some((block) => block.kind === "tool" && block.toolName === "bash"),
	JSON.stringify(assistantBlocks.find((block) => block.kind === "tool")),
);
check("every captured message renders at least one block", userBlocks.length > 0 && assistantBlocks.length > 0, `${userBlocks.length} + ${assistantBlocks.length}`);

const stringContent = messageToBlocks({ role: "user", content: "plain string content" });
check("string content still renders", stringContent.length === 1 && stringContent[0].kind === "text", JSON.stringify(stringContent));

check("empty content renders nothing (no fake block)", messageToBlocks({ role: "assistant", content: [] }).length === 0);
check("unknown block kinds are dropped, not turned into text", messageToBlocks({ role: "assistant", content: [{ type: "mystery", text: "x" }] }).length === 0);
check("messageToText only returns text blocks", messageToText(assistant) === "life-three", JSON.stringify(messageToText(assistant)));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
