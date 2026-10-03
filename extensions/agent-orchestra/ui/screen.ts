/**
 * Lane screen: fullscreen custom component for /orchestra.
 * Edit mode: arrange steps with arrow keys. Monitor mode: live badges while the chain runs.
 * Keyboard-first; every line fits the given width (truncateToWidth).
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Pipeline, Step } from "../model.ts";
import { GOAL_TOKEN, UPSTREAM_PLACEHOLDER } from "../model.ts";
import type { PaletteEntry } from "../roles.ts";
import type { StepRun } from "../runner.ts";

export type ScreenAction =
	| { action: "close" }
	| { action: "run" }
	| { action: "run-step"; stepId: string }
	| { action: "edit-step"; stepId: string }
	| { action: "edit-goal" }
	| { action: "steer"; stepId: string }
	| { action: "stop-step"; stepId: string }
	| { action: "save" };

const GLYPH: Record<string, string> = {
	queued: "○",
	running: "●",
	done: "✔",
	failed: "✗",
	stopped: "⏹",
};

export class LaneScreen implements Component {
	private tui: TUI;
	private theme: Theme;
	private pipeline: Pipeline;
	private runs: Map<string, StepRun>;
	private paletteEntries: PaletteEntry[];
	mode: "edit" | "monitor" = "edit";
	private selected = 0;
	private paletteOpen = false;
	private paletteSelected = 0;
	private log: string[] = [];
	/** resolver supplied by the command handler */
	finish: (a: ScreenAction) => void = () => {};

	constructor(
		tui: TUI,
		theme: Theme,
		pipeline: Pipeline,
		runs: Map<string, StepRun>,
		paletteEntries: PaletteEntry[],
	) {
		this.tui = tui;
		this.theme = theme;
		this.pipeline = pipeline;
		this.runs = runs;
		this.paletteEntries = paletteEntries;
	}

	/** Called by the chain hooks; invalidate + request render. */
	refresh(logLine?: string): void {
		if (logLine) {
			this.log.push(logLine);
			if (this.log.length > 6) this.log.shift();
		}
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		/* stateless render — nothing cached */
	}

	private c(token: "accent" | "success" | "error" | "warning" | "muted" | "text" | "toolTitle", s: string): string {
		try {
			return this.theme.fg(token, s);
		} catch {
			return s;
		}
	}

	handleInput(data: string): void {
		if (this.paletteOpen) {
			if (matchesKey(data, Key.escape)) {
				this.paletteOpen = false;
			} else if (matchesKey(data, Key.up)) {
				this.paletteSelected = Math.max(0, this.paletteSelected - 1);
			} else if (matchesKey(data, Key.down)) {
				this.paletteSelected = Math.min(this.paletteEntries.length - 1, this.paletteSelected + 1);
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				const entry = this.paletteEntries[this.paletteSelected];
				if (entry) {
					this.pipeline.steps.push({
						id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
						role: entry.agent,
						title: entry.name,
						taskTemplate: "",
					});
					this.selected = this.pipeline.steps.length - 1;
				}
				this.paletteOpen = false;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const steps = this.pipeline.steps;
		const sel = steps[this.selected];

		if (matchesKey(data, Key.escape) || data === "q") {
			this.finish({ action: "close" });
		} else if (data === "s" && data.length === 1) {
			// s = steer in monitor mode; ctrl+s handled below for save
			if (this.mode === "monitor" && sel) this.finish({ action: "steer", stepId: sel.id });
		} else if (matchesKey(data, "ctrl+s")) {
			this.finish({ action: "save" });
		} else if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, steps.length - 1), this.selected + 1);
		} else if (this.mode === "edit") {
			if (matchesKey(data, Key.left) && this.selected > 0) {
				[steps[this.selected - 1], steps[this.selected]] = [steps[this.selected], steps[this.selected - 1]];
				this.selected--;
			} else if (matchesKey(data, Key.right) && this.selected < steps.length - 1) {
				[steps[this.selected + 1], steps[this.selected]] = [steps[this.selected], steps[this.selected + 1]];
				this.selected++;
			} else if (data === "a") {
				this.paletteOpen = true;
				this.paletteSelected = 0;
			} else if (data === "d" && sel) {
				steps.splice(this.selected, 1);
				this.selected = Math.min(this.selected, Math.max(0, steps.length - 1));
			} else if (data === "w" && sel) {
				sel.worktree = !sel.worktree;
			} else if (data === "e" && sel) {
				this.finish({ action: "edit-step", stepId: sel.id });
			} else if (data === "g") {
				this.finish({ action: "edit-goal" });
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				this.finish({ action: "run" });
			} else if (matchesKey(data, Key.space) && sel) {
				this.finish({ action: "run-step", stepId: sel.id });
			}
		} else if (this.mode === "monitor") {
			if (data === "x" && sel) this.finish({ action: "stop-step", stepId: sel.id });
			else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				this.finish({ action: "close" });
			}
		}
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const L: string[] = [];
		const cut = (s: string) => truncateToWidth(s, Math.max(20, width - 1));
		const title = this.pipeline.name || "pipeline";
		L.push(cut(this.c("toolTitle", `─ orchestra · ${title} · ${this.mode} mode `).padEnd(width, "─")));
		const goal = this.pipeline.goal?.trim();
		const needsGoal = this.pipeline.steps.some((s) => s.taskTemplate.includes(GOAL_TOKEN));
		L.push(cut(`  ${this.c("muted", "goal: ")}${this.c(goal ? "text" : needsGoal ? "warning" : "muted", goal || (needsGoal ? "(required — press g)" : "(not set — press g)"))}`));
		const steps = this.pipeline.steps;
		if (steps.length === 0) {
			L.push(cut(this.c("muted", "  (empty lane — press a to add a role)")));
		}
		steps.forEach((step, i) => {
			const run = this.runs.get(step.id);
			const state = run?.state ?? "queued";
			const glyph = GLYPH[state] ?? "○";
			const color =
				state === "running" ? "accent" : state === "done" ? "success" : state === "failed" ? "error" : state === "stopped" ? "warning" : "muted";
			const elapsed = state === "running" && run?.startedAt ? ` ${(Math.floor((Date.now() - run.startedAt) / 1000))}s` : "";
			const pointer = i === this.selected ? "▸" : " ";
			const flags = [step.worktree ? "worktree" : "", step.parallel ? "parallel" : ""].filter(Boolean).join(",");
			const head = `${pointer} ${i + 1} [${step.title}] ${step.role}${flags ? ` (${flags})` : ""}`;
			L.push(cut(`${this.c(color, `${glyph} `)}${this.c(i === this.selected ? "text" : "muted", head)}${this.c(color, elapsed)}`));
			const task = step.taskTemplate.split("\n")[0] || "(no task)";
			L.push(cut(`    ${this.c("muted", task.slice(0, Math.max(10, width - 8)))}`));
			if (run?.error) L.push(cut(`    ${this.c("error", `error: ${run.error.slice(0, Math.max(10, width - 16))}`)}`));
			if (i < steps.length - 1) {
				const link = steps[i + 1].parallel ? "═ parallel with next" : `↓ ${steps[i + 1].taskTemplate.includes(UPSTREAM_PLACEHOLDER) ? UPSTREAM_PLACEHOLDER : "upstream output"}`;
				L.push(cut(`  ${this.c("muted", link)}`));
			}
		});

		if (this.paletteOpen) {
			L.push(cut(this.c("toolTitle", "─ role palette ─")));
			this.paletteEntries.forEach((entry, i) => {
				const pointer = i === this.paletteSelected ? "▸" : " ";
				L.push(cut(`${pointer} ${this.c(i === this.paletteSelected ? "text" : "muted", `${entry.name.padEnd(14)} ${entry.agent.padEnd(12)} ${entry.description}`)}`));
			});
		}

		if (this.log.length) {
			L.push(cut(this.c("muted", "─ log ─")));
			for (const line of this.log) L.push(cut(`  ${this.c("muted", line)}`));
		}

		const hints =
			this.mode === "edit"
				? "↑↓ select  ←→ reorder  a add  e task  g goal  d del  w worktree  ⏎ run chain  space run step  ^S save  esc close"
				: "↑↓ select  s steer  x stop  esc/⏎ close";
		L.push(cut(this.c("muted", hints)));
		return L;
	}
}
