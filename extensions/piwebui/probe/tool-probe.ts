/**
 * Tool cards must show the input and the output, also for a reloaded conversation.
 *
 * Fixtures are captured from a live `get_messages` response: a tool call lives in the assistant
 * message (`toolCall` with `arguments`), its output in the following `toolResult` message.
 */
import { collectToolRuns, messageToBlocks } from "../web/src/types.ts";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const history = [
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "let me run that" },
			{
				type: "toolCall",
				id: "call_00_pK1iRWQ59TD9VsPXR5zs2828",
				name: "bash",
				arguments: { command: "node probe/run-lifecycle-probe.ts", timeout: 900 },
			},
		],
	},
	{
		role: "toolResult",
		toolCallId: "call_00_pK1iRWQ59TD9VsPXR5zs2828",
		toolName: "bash",
		content: [{ type: "text", text: "PASS  a run starts — agent_start seen\n6/6 checks passed\n" }],
		isError: false,
		timestamp: 1791047033766,
	},
	// an interrupted call: no result message at all
	{ role: "assistant", content: [{ type: "toolCall", id: "call_orphan", name: "computer", arguments: { action: "screenshot" } }] },
	// a failing call
	{ role: "assistant", content: [{ type: "toolCall", id: "call_fail", name: "read", arguments: { path: "/nope" } }] },
	{ role: "toolResult", toolCallId: "call_fail", toolName: "read", content: [{ type: "text", text: "ENOENT" }], isError: true },
	// a result whose only payload is an image
	{ role: "assistant", content: [{ type: "toolCall", id: "call_shot", name: "computer", arguments: { action: "screenshot" } }] },
	{ role: "toolResult", toolCallId: "call_shot", toolName: "computer", content: [{ type: "image", data: "…" }], isError: false },
];

const runs = collectToolRuns(history);
const bash = runs["call_00_pK1iRWQ59TD9VsPXR5zs2828"];
check("the call is found in the history", Boolean(bash), Object.keys(runs).join(","));
check("the tool name comes from the history", bash?.toolName === "bash", bash?.toolName);
check("the input (arguments) is captured", (bash?.args as { command?: string })?.command === "node probe/run-lifecycle-probe.ts", JSON.stringify(bash?.args));
check("the output comes from the toolResult message", bash?.output.includes("6/6 checks passed"), JSON.stringify(bash?.output)?.slice(0, 60));
check("a finished call is `done`, not `unknown`", bash?.status === "done", bash?.status);
check("a failing call is `error`", runs["call_fail"]?.status === "error", runs["call_fail"]?.status);
check("an interrupted call stays honestly `unknown`", runs["call_orphan"]?.status === "unknown" && !runs["call_orphan"]?.output, runs["call_orphan"]?.status);
check("an interrupted call still shows its input", (runs["call_orphan"]?.args as { action?: string })?.action === "screenshot", JSON.stringify(runs["call_orphan"]?.args));
check("an image result is reported as text, not dropped", runs["call_shot"]?.output === "[image]", JSON.stringify(runs["call_shot"]?.output));
check("history runs carry no invented timing", runs["call_00_pK1iRWQ59TD9VsPXR5zs2828"]?.startedAt === undefined, String(bash?.startedAt));

const blocks = messageToBlocks(history[0]);
const toolBlock = blocks.find((block) => block.kind === "tool");
check(
	"the message block carries name and args for the card",
	toolBlock?.kind === "tool" && toolBlock.toolName === "bash" && (toolBlock.args as { timeout?: number })?.timeout === 900,
	JSON.stringify(toolBlock),
);
check("thinking still gets its own block", blocks.some((block) => block.kind === "thinking"), blocks.map((b) => b.kind).join(","));

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
