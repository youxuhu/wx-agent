/**
 * agent-presets — main-callable presets: fixed recipes of agent roles that the
 * main agent can invoke for specific kinds of problems (coding, computeruse,
 * research, review-loop, quick-fix, or its own presets in ~/.pi/agent/presets).
 *
 * The tool runs the recipe foreground, serially, through ctx.executeTool("subagent")
 * — same validation, permission and usage accounting as a normal subagent call —
 * and returns per-step facts plus the last step's full output.
 *
 * Red lines: code owns invariants (validation, truncation, stop-on-failure);
 * no strategy is decided here. Prompts are pure facts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildTask, type Preset } from "./model.ts";
import { listPresetNames, loadAllPresets, loadPreset } from "./presets.ts";

interface StepFact {
	title: string;
	agent: string;
	status: "ok" | "failed" | "skipped";
	elapsedMs: number;
	outputChars: number;
	error?: string;
}

interface PresetDetails {
	preset: string;
	goal: string;
	status: "ok" | "failed";
	elapsedMs: number;
	steps: StepFact[];
}

function textOf(result: { content?: unknown }): string {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: string; text: string } => {
			return typeof c === "object" && c !== null && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string";
		})
		.map((c) => c.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Preset list is read once at load for the tool description (files are config, not processes).
	const { presets, errors } = loadAllPresets();
	const catalog = presets.map((p) => `- ${p.name}: ${p.description ?? p.steps.map((s) => s.title).join(" → ")}`).join("\n");

	pi.registerTool({
		name: "preset",
		label: "Agent Preset",
		description: [
			"Run a preset multi-agent recipe for a specific kind of problem.",
			"Each step is a real subagent call (foreground, serial); upstream output is injected into the next step.",
			"Use it when the problem matches a recipe below; use a direct subagent call when you need a single focused child.",
			"Presets:",
			catalog || "(none found)",
			errors.length ? `Unreadable preset files: ${errors.join("; ")}` : "",
			"Returns per-step facts and the last step's full output. Stops at the first failing step and reports its error verbatim.",
		]
			.filter(Boolean)
			.join("\n"),
		parameters: Type.Object({
			preset: StringEnum(listPresetNames() as [string, ...string[]]),
			goal: Type.String({ description: "What the recipe should achieve; replaces {{goal}} in step tasks" }),
			context: Type.Optional(
				Type.String({ description: "Extra facts to include (paths, error text, constraints); replaces {{context}}" }),
			),
			steps: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional subset of step names to run, in preset order (must all exist in the preset)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const presetName = String(params.preset ?? "").trim();
			const goal = String(params.goal ?? "").trim();
			const context = params.context === undefined ? "" : String(params.context);
			const requested = Array.isArray(params.steps) ? params.steps.map((s) => String(s)) : undefined;

			let preset: Preset;
			try {
				preset = loadPreset(presetName);
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `preset failed: ${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
					details: undefined,
				};
			}

			// invariant: subset may only narrow, and every requested name must exist
			let steps = preset.steps;
			if (requested && requested.length > 0) {
				const byTitle = new Map(preset.steps.map((s) => [s.title, s]));
				const missing = requested.filter((r) => !byTitle.has(r));
				if (missing.length > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `preset failed: unknown step(s) ${missing.join(", ")}; available in "${preset.name}": ${preset.steps
									.map((s) => s.title)
									.join(", ")}`,
							},
						],
						isError: true,
						details: undefined,
					};
				}
				const order = new Map(preset.steps.map((s, i) => [s.title, i]));
				steps = [...requested].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map((t) => byTitle.get(t)!);
			}

			const facts: StepFact[] = [];
			const startedAll = Date.now();
			let upstream: string | null = null;
			let failed = false;

			for (const [i, step] of steps.entries()) {
				if (signal?.aborted) {
					facts.push({ title: step.title, agent: step.role, status: "skipped", elapsedMs: 0, outputChars: 0, error: "aborted" });
					failed = true;
					break;
				}
				const task = buildTask(step, { goal, context, upstream });
				onUpdate?.({
					content: [{ type: "text" as const, text: `preset ${preset.name}: step ${i + 1}/${steps.length} ${step.title} (${step.role})…` }],
					details: undefined,
				});
				const t0 = Date.now();
				const args: Record<string, unknown> = { agent: step.role, task, ...(step.agentOverrides ?? {}) };
				if (step.worktree) args.worktree = true;
				const outcome = await ctx.executeTool("subagent", args, { signal });
				const elapsedMs = Date.now() - t0;
				const text = textOf(outcome.result as { content?: unknown });
				if (outcome.isError) {
					facts.push({
						title: step.title,
						agent: step.role,
						status: "failed",
						elapsedMs,
						outputChars: text.length,
						error: text.slice(0, 2000) || "(no error text)",
					});
					failed = true;
					break;
				}
				facts.push({ title: step.title, agent: step.role, status: "ok", elapsedMs, outputChars: text.length });
				upstream = text || upstream;
			}

			const elapsedAll = Date.now() - startedAll;
			const lastOk = [...facts].reverse().find((f) => f.status === "ok");
			const lastOutput = lastOk ? extractLastOutput(upstream) : "";
			const header = [
				`preset=${preset.name}  goal="${goal}"  steps=${facts.length}/${steps.length}  status=${failed ? "failed" : "ok"}  elapsed=${Math.round(elapsedAll / 1000)}s`,
				...facts.map(
					(f, i) =>
						`${String(i + 1)}. ${f.title.padEnd(12)} ${f.agent.padEnd(12)} ${f.status.padEnd(6)} ${Math.round(f.elapsedMs / 1000)}s  out=${f.outputChars} chars${
							f.error ? `  error=${f.error.split("\n")[0].slice(0, 160)}` : ""
						}`,
				),
			].join("\n");
			const body = lastOutput ? `\n\n-- last step output --\n${lastOutput}` : "";
			const details: PresetDetails = {
				preset: preset.name,
				goal,
				status: failed ? "failed" : "ok",
				elapsedMs: elapsedAll,
				steps: facts,
			};
			return {
				content: [{ type: "text" as const, text: header + body }],
				isError: failed,
				details,
			};
		},
	});
}

/** The final upstream carry is what the last successful step produced. */
function extractLastOutput(upstream: string | null): string {
	return upstream ?? "";
}
