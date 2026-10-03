/**
 * ui.ts — result rendering + image pipeline helpers (PLAN §3.3, §2).
 * formatObservation() emits the fixed text-block template; widget tree rendering
 * indents by tree depth per the PLAN example.
 */

import type { Observation } from "./gate";
import type { WindowInfo } from "./platform";

/** Renders the widget tree in the PLAN §3.3 `widgets:` block format. */
export function renderWidgetTree(obs: Observation): string {
	const root = obs.widgetTree;
	if (!root) return ""; // Phase 1: no tree yet — the block stays empty
	const lines: string[] = ["widgets:"];
	const walk = (n: Observation["widgetTree"] & object, depth: number) => {
		const node = n as NonNullable<Observation["widgetTree"]>;
		const pad = " ".repeat(depth + 1);
		const label = node.label.length > 80 ? `${node.label.slice(0, 80)}…` : node.label;
		const value = node.value ? ` "${node.value}"` : "";
		lines.push(`${pad}${node.index} ${node.role} "${label}"${value} center(${node.center.x},${node.center.y})`);
		node.children.forEach((c) => walk(c, depth + 1));
	};
	walk(root, 0);
	return lines.join("\n");
}

function formatFocused(windows: WindowInfo[]): string {
	const f = windows.find((w) => w.isFocused);
	if (!f) return "none";
	return `${f.appName} — ${f.title || "(no title)"}`;
}

/**
 * formatObservation — the fixed text-block template (PLAN §3.3):
 *
 * [computer] <action> <target> → ok (round N/max)
 * state: <hash16> | focused: App — title
 * widgets: ...
 * blocked: none
 */
export function formatObservation(opts: {
	action: string;
	target: string;
	ok: boolean;
	round: number;
	maxRounds: number;
	obs: Observation;
}): string {
	const { action, target, ok, round, maxRounds, obs } = opts;
	const head = `[computer] ${action} ${target} → ${ok ? "ok" : "failed"} (round ${round}/${maxRounds})`;
	const state = `state: ${obs.stateHash} | focused: ${formatFocused(obs.windows)}`;
	const widgets = renderWidgetTree(obs);
	const blocked = obs.blocked
		? `blocked: ${obs.blocked.kind} — ${obs.blocked.detail}. hint: ${obs.blocked.hint}`
		: "blocked: none";
	return [head, state, widgets, blocked].filter((s) => s !== "").join("\n");
}

/** Plain text notice block (parameter errors, platform-unsupported, gate denials). */
export function formatNotice(text: string): string {
	return `[computer] ${text}`;
}
