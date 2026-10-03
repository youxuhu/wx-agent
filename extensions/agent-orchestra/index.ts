/**
 * agent-orchestra — in-terminal subagent lane orchestrator.
 * /orchestra [pipeline-name] opens a fullscreen lane UI; arrow keys arrange
 * preset-role agents (explore/build/computeruser/review/advisor…) into a
 * pipeline; the chain runs through the pi-subagents RPC bus with upstream
 * output injected into each downstream task.
 *
 * Red lines: data + UI only. No strategy is fixed here; prompts are pure facts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultPipeline, newStep, type Pipeline } from "./model.ts";
import { listPipelines, loadPipeline, savePipeline } from "./store.ts";
import { palette } from "./roles.ts";
import { OrchestraRunner, type StepRun } from "./runner.ts";
import { LaneScreen, type ScreenAction } from "./ui/screen.ts";

interface Session {
	runner: OrchestraRunner | null;
	pipeline: Pipeline;
	runs: Map<string, StepRun>;
	open: boolean;
	unsubs: (() => void)[];
}

export default function (pi: ExtensionAPI) {
	const session: Session = { runner: null, pipeline: defaultPipeline(), runs: new Map(), open: false, unsubs: [] };

	pi.on("session_shutdown", () => {
		session.runner?.dispose();
		for (const u of session.unsubs) u();
		session.unsubs = [];
	});

	pi.registerCommand("orchestra", {
		description: "Open the subagent lane orchestrator (arrow-key pipeline editor)",
		handler: async (args, ctx) => {
			// non-TUI degradation: print the pipeline JSON (pure data, render-independent)
			if (ctx.mode !== "tui") {
				const name = args.trim();
				const p = name ? loadPipeline(name, ctx.cwd) : session.pipeline;
				// eslint-disable-next-line no-console
				console.log(JSON.stringify(p ?? defaultPipeline(), null, 2));
				return;
			}
			if (session.open) {
				ctx.ui.notify("orchestra screen is already open", "warning");
				return;
			}

			const arg = args.trim();
			if (arg) {
				const loaded = loadPipeline(arg, ctx.cwd);
				if (loaded) session.pipeline = loaded;
				else {
					session.pipeline = defaultPipeline();
					session.pipeline.name = arg;
				}
			} else if (session.pipeline.steps.length === 0) {
				const existing = listPipelines(ctx.cwd);
				if (existing.length > 0) {
					const picked = await ctx.ui.select("Load pipeline", existing.map((e) => `${e.name} (${e.scope})`));
					if (picked) {
						const name = picked.replace(/ \((global|project)\)$/, "");
						session.pipeline = loadPipeline(name, ctx.cwd) ?? session.pipeline;
					}
				}
			}

			await loop(ctx);
		},
	});

	/** Open the screen, dispatch the resulting action, repeat until close. */
	async function loop(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): Promise<void> {
		session.open = true;
		try {
			for (;;) {
				const action = await ctx.ui.custom<ScreenAction>(
					(tui, theme, _kb, done) => {
						const screen = new LaneScreen(tui, theme, session.pipeline, session.runs, palette());
						screen.finish = (a) => done(a);
						return screen;
					},
				);
				if (!action || action.action === "close") return;

				if (action.action === "save") {
					const path = savePipeline(session.pipeline, ctx.cwd, "global");
					ctx.ui.notify(`saved: ${path}`, "info");
					continue;
				}
				if (action.action === "edit-step") {
					const step = session.pipeline.steps.find((s) => s.id === action.stepId);
					if (!step) continue;
					const title = await ctx.ui.input("Step title (english)", step.title);
					if (title !== undefined && title.trim()) step.title = title.trim();
					const task = await ctx.ui.editor(`Task for [${step.title}] — ${"{{upstream}}"} injects the previous step's output`, step.taskTemplate);
					if (task !== undefined) step.taskTemplate = task;
					continue;
				}
				if (action.action === "run" || action.action === "run-step") {
					await runChainUi(ctx, action.action === "run" ? null : action.stepId);
					continue;
				}
				if (action.action === "steer") {
					const msg = await ctx.ui.input(`Steer [${label(action.stepId)}]`, "corrective message…");
					if (msg && session.runner) {
						try {
							const delivery = await session.runner.steer(action.stepId, msg);
							ctx.ui.notify(`steer delivery: ${delivery}`, "info");
						} catch (e) {
							ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
						}
					}
					continue;
				}
				if (action.action === "stop-step") {
					try {
						await session.runner?.stop(action.stepId);
					} catch (e) {
						ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
					}
					continue;
				}
			}
		} finally {
			session.open = false;
		}
	}

	function label(stepId: string): string {
		return session.pipeline.steps.find((s) => s.id === stepId)?.title ?? stepId;
	}

	/** Monitor-mode screen + chain execution. */
	async function runChainUi(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1], onlyStepId: string | null): Promise<void> {
		if (session.pipeline.steps.length === 0) {
			ctx.ui.notify("orchestra: lane is empty", "warning");
			return;
		}
		session.runner ??= new OrchestraRunner(pi);
		const runner = session.runner;
		try {
			await runner.ensureReady();
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			return;
		}

		let screen: LaneScreen | null = null;
		const hooks = {
			onUpdate: () => screen?.refresh(),
			onLog: (line: string) => screen?.refresh(line),
		};

		const chainPromise = (onlyStepId
			? runner.runStep(session.pipeline.steps.find((s) => s.id === onlyStepId) ?? newStep("worker", "worker"), null, hooks)
			: runner.runChain(session.pipeline, hooks)
		)
			.catch((e) => ctx.ui.notify(e instanceof Error ? e.message : String(e), "error"))
			.finally(() => screen?.refresh("chain finished"));

		await ctx.ui.custom<ScreenAction>(
			(tui, theme, _kb, done) => {
				screen = new LaneScreen(tui, theme, session.pipeline, session.runs, palette());
				screen.mode = "monitor";
				screen.finish = (a) => {
					if (a.action === "close") done(a);
					else void handleMonitorAction(a);
				};
				return screen;
			},
		);
		await chainPromise;

		async function handleMonitorAction(a: ScreenAction): Promise<void> {
			if (a.action === "steer") {
				const msg = await ctx.ui.input(`Steer [${label(a.stepId)}]`, "corrective message…");
				if (msg) {
					try {
						const delivery = await runner.steer(a.stepId, msg);
						ctx.ui.notify(`steer delivery: ${delivery}`, "info");
					} catch (e) {
						ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
					}
				}
			} else if (a.action === "stop-step") {
				try {
					await runner.stop(a.stepId);
				} catch (e) {
					ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
				}
			}
		}
	}

	// convenience: /orchestra:run <name> prints the dry-run spawn plan (facts only)
	pi.registerCommand("orchestra-dry", {
		description: "Print the exact subagent spawns the lane would issue (dry run)",
		handler: async (args, ctx) => {
			const name = args.trim();
			const p: Pipeline | null = name ? loadPipeline(name, ctx.cwd) : session.pipeline;
			const plan = p ?? defaultPipeline();
			for (const [i, step] of plan.steps.entries()) {
				const upstream = i > 0 ? "<upstream output>" : null;
				const task = step.taskTemplate
					? " " + (upstream && step.taskTemplate.includes("{{upstream}}") ? step.taskTemplate.replace(/\{\{upstream\}\}/g, "<upstream output>").slice(0, 120) : step.taskTemplate.slice(0, 120))
					: "";
				// eslint-disable-next-line no-console
				console.log(`spawn #${i + 1} agent=${step.role} worktree=${step.worktree === true} parallel=${step.parallel === true} task="${task}"`);
			}
			if (plan.steps.length === 0) console.log("(empty lane)");
		},
	});
}
