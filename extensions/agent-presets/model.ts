/**
 * Preset model: an ordered recipe of agent steps + task templating.
 * Pure data + validation. No execution, no UI.
 */

export interface Step {
	id: string;
	/** agent name for the subagent tool (english: scout/worker/reviewer/…) */
	role: string;
	/** step name, used by the `steps` subset selector */
	title: string;
	/** task text; {{goal}} and {{upstream}} are replaced at run time */
	taskTemplate: string;
	/** isolate this step in a managed git worktree */
	worktree?: boolean;
	/** extra subagent tool params passed through (model/toolBudget/acceptance/…) */
	agentOverrides?: Record<string, unknown>;
}

export interface Preset {
	name: string;
	/** free-form goal text; {{goal}} is replaced with it */
	goal?: string;
	description?: string;
	steps: Step[];
}

export const GOAL_TOKEN = "{{goal}}";
export const UPSTREAM_TOKEN = "{{upstream}}";
export const CONTEXT_TOKEN = "{{context}}";

export function newId(prefix = "s"): string {
	return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Validate & normalize parsed JSON. Throws with a factual message on bad shape. */
export function parsePreset(data: unknown, source = "preset"): Preset {
	if (typeof data !== "object" || data === null) throw new Error(`${source}: not an object`);
	const o = data as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name.trim()) throw new Error(`${source}: missing name`);
	if (!Array.isArray(o.steps)) throw new Error(`${source}: steps must be an array`);
	const steps: Step[] = o.steps.map((raw, i) => {
		if (typeof raw !== "object" || raw === null) throw new Error(`${source}: steps[${i}] not an object`);
		const s = raw as Record<string, unknown>;
		if (typeof s.role !== "string" || !s.role.trim()) throw new Error(`${source}: steps[${i}] missing role`);
		if (typeof s.taskTemplate !== "string") throw new Error(`${source}: steps[${i}] missing taskTemplate`);
		return {
			id: typeof s.id === "string" && s.id ? s.id : newId(),
			role: s.role,
			title: typeof s.title === "string" && s.title ? s.title : s.role,
			taskTemplate: s.taskTemplate,
			worktree: s.worktree === true,
			agentOverrides:
				typeof s.agentOverrides === "object" && s.agentOverrides !== null
					? (s.agentOverrides as Record<string, unknown>)
					: undefined,
		};
	});
	if (steps.length === 0) throw new Error(`${source}: steps is empty`);
	const titles = new Set<string>();
	for (const s of steps) {
		if (titles.has(s.title)) throw new Error(`${source}: duplicate step title "${s.title}"`);
		titles.add(s.title);
	}
	return {
		name: o.name,
		goal: typeof o.goal === "string" ? o.goal : undefined,
		description: typeof o.description === "string" ? o.description : undefined,
		steps,
	};
}

export interface TaskInputs {
	goal?: string;
	context?: string;
	upstream?: string | null;
	maxUpstreamChars?: number;
}

/**
 * Build the concrete task text for a step.
 * {{goal}} / {{context}} / {{upstream}} are replaced where present; when a step has
 * no {{upstream}} token the upstream output is appended as a labelled section.
 * Upstream is truncated with a factual marker — never silently.
 */
export function buildTask(step: Step, inputs: TaskInputs): string {
	const max = inputs.maxUpstreamChars ?? 8000;
	const goal = (inputs.goal ?? "").trim();
	const context = (inputs.context ?? "").trim();
	const upstreamRaw = inputs.upstream ?? "";
	const upstream =
		upstreamRaw.length > max ? `${upstreamRaw.slice(0, max)}\n...[upstream truncated at ${max} chars]` : upstreamRaw;

	let text = step.taskTemplate;
	if (text.includes(GOAL_TOKEN)) text = text.split(GOAL_TOKEN).join(goal || "(no goal set)");
	// context mirrors upstream: replaced inline when the token is present, appended otherwise
	if (text.includes(CONTEXT_TOKEN)) text = text.split(CONTEXT_TOKEN).join(context || "(no extra context)");
	else if (context) text = `${text}\n\n-- extra context --\n${context}`;
	if (text.includes(UPSTREAM_TOKEN)) return text.split(UPSTREAM_TOKEN).join(upstream || "(no upstream output)");
	if (upstream) return `${text}\n\n-- upstream output --\n${upstream}`;
	return text;
}
