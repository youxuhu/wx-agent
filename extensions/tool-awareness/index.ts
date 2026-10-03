/**
 * tool-awareness — make extension-registered tools discoverable to the model.
 *
 * v2 (progressive disclosure): the system prompt gets only a ONE-LINE INDEX
 * (name + 8-word hint). Long usage docs live in each tool's namespace
 * instructions, readable by codemode scripts via describeNamespace(), or by
 * the model via action:"help"-style affordances — never dumped here.
 *
 * Runs chained after plan-switch's role injection; plan and build roles both
 * get the index.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DESC_LENGTH = 60;

export default function toolAwareness(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const active = new Set(pi.getActiveTools());
		const lines = pi
			.getAllTools()
			.filter(
				(t) =>
					t.sourceInfo?.source !== "builtin" &&
					t.sourceInfo?.source !== "sdk" &&
					active.has(t.name),
			)
			.map((t) => {
				const desc = (t.description || "").split("\n")[0]?.trim().slice(0, MAX_DESC_LENGTH) ?? "";
				return `- ${t.name}${desc ? ` — ${desc}` : ""}`;
			});
		if (lines.length === 0) return undefined;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## EXTENSION TOOLS (index only — details on demand)\n" +
				lines.join("\n") +
				"\nDetails: tool_search / describeTool(name) (codemode) · computer action:\"help\" · read_pdf/read_xlsx accept the same paths as read.",
		};
	});
}
