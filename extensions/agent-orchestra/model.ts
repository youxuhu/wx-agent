/**
 * Orchestration data model: Pipeline = ordered Steps (the lane).
 * Pure data + validation. No execution, no UI.
 */

export interface Step {
	id: string;
	/** agent name for the subagent tool (english: scout/worker/reviewer/…/custom) */
	role: string;
	/** display name in the lane, e.g. "explore" */
	title: string;
	/** task text; {{upstream}} is replaced with the previous step's output */
	taskTemplate: string;
	/** run parallel with the previous step (default serial: output→input pipe) */
	parallel?: boolean;
	/** isolate this step in a managed git worktree */
	worktree?: boolean;
	/** extra subagent tool params passed through (model/toolBudget/acceptance/…) */
	agentOverrides?: Record<string, unknown>;
}

export interface Pipeline {
	name: string;
	steps: Step[];
}

const UPSTREAM_TOKEN = "{{upstream}}";

export function newId(): string {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newStep(role: string, title: string): Step {
	return { id: newId(), role, title, taskTemplate: "" };
}

export function defaultPipeline(): Pipeline {
	return { name: `pipeline-${new Date().toISOString().slice(0, 10)}`, steps: [] };
}

/** Validate & normalize parsed JSON. Throws with a factual message on bad shape. */
export function parsePipeline(data: unknown): Pipeline {
	if (typeof data !== "object" || data === null) throw new Error("pipeline: not an object");
	const o = data as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name.trim()) throw new Error("pipeline: missing name");
	if (!Array.isArray(o.steps)) throw new Error("pipeline: steps must be an array");
	const steps: Step[] = o.steps.map((raw, i) => {
		if (typeof raw !== "object" || raw === null) throw new Error(`steps[${i}]: not an object`);
		const s = raw as Record<string, unknown>;
		if (typeof s.role !== "string" || !s.role.trim()) throw new Error(`steps[${i}]: missing role`);
		if (typeof s.taskTemplate !== "string") throw new Error(`steps[${i}]: missing taskTemplate`);
		return {
			id: typeof s.id === "string" && s.id ? s.id : newId(),
			role: s.role,
			title: typeof s.title === "string" && s.title ? s.title : s.role,
			taskTemplate: s.taskTemplate,
			parallel: s.parallel === true,
			worktree: s.worktree === true,
			agentOverrides:
				typeof s.agentOverrides === "object" && s.agentOverrides !== null
					? (s.agentOverrides as Record<string, unknown>)
					: undefined,
		};
	});
	return { name: o.name, steps };
}

/**
 * Build the concrete task text for a step given the upstream output.
 * Placeholder is replaced when present; otherwise the upstream section is appended.
 * Output is truncated to `maxUpstreamChars` with a factual marker (never silently).
 */
export function buildTask(step: Step, upstream: string | null, maxUpstreamChars = 8000): string {
	if (!upstream) return renderTemplate(step.taskTemplate, null);
	const trimmed = upstream.length > maxUpstreamChars
		? `${upstream.slice(0, maxUpstreamChars)}\n...[upstream truncated at ${maxUpstreamChars} chars]`
		: upstream;
	return renderTemplate(step.taskTemplate, trimmed);
}

function renderTemplate(tpl: string, upstream: string | null): string {
	if (tpl.includes(UPSTREAM_TOKEN)) {
		return tpl.split(UPSTREAM_TOKEN).join(upstream ?? "(no upstream output)");
	}
	return upstream ? `${tpl}\n\n-- upstream output --\n${upstream}` : tpl;
}

export const UPSTREAM_PLACEHOLDER = UPSTREAM_TOKEN;
