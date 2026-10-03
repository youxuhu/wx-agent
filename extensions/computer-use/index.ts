/**
 * computer-use — see and control the desktop GUI from pi (PLAN v3.1).
 *
 * Single `computer` tool (screenshot / click / type / key / scroll / wait / list_windows /
 * activate / help) plus the /cua command (status | ask | bypass | clear | doctor).
 * v3.1: tiered observation (full/tree/minimal, PLAN §1) with deterministic screenshot
 * triggers, Swift AX widget tree (§3, logical coordinates), bug fixes B1-B4 (§2), and
 * prompt progressive disclosure L0/L1/L2 (§4: short resident prompt, one-time BRIEFING,
 * on-demand MANUAL via action:"help").
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ImageContent, TextContent } from "@earendil-works/pi-coding-agent";
import { ProgressController } from "./controller";
import {
	buildWidgetIndex,
	decideLevel,
	detectBlocked,
	treeChangedFraction,
	treeFingerprint,
	treeSample,
	windowKey,
	type WidgetNode,
	type Observation,
} from "./gate";
import { gateAction, loadConfig, saveConfig, type CuaConfig } from "./permission";
import { createAdapter, type PlatformAdapter, type Point, type WindowInfo } from "./platform";
import { BRIEFING, formatNotice, formatObservation, MANUAL } from "./ui";

type Result = Array<TextContent | ImageContent>;

const MUTATING = new Set(["left_click", "double_click", "right_click", "type", "key", "scroll", "activate"]);
const REPEAT_WINDOW_MS = 3_000; // PLAN §1.2: same (action,target) within 3s ⇒ minimal
const HEARTBEAT_ACTIONS = 10; // PLAN §1.2: ≥10 actions since last full ⇒ full

interface SessionState {
	adapter: PlatformAdapter | null;
	controller: ProgressController;
	cfg: CuaConfig;
	lastHash: string | null;
	lastWindows: WindowInfo[];
	knownWindows: Set<string> | null;
	widgetIndex: Map<number, Point>;
	lastRaster: { width: number; height: number };
	lastLogical: { width: number; height: number };
	round: number;
	// v3.1 tiered-observation state
	briefingDone: boolean; // L1: briefing shown once per session (§4.3)
	firstOfTask: boolean; // next observation is the task's first (reset on turn_end)
	actionsSinceFull: number | null; // null = no full observation taken yet in this task
	lastFrontPid: number | null; // B3: previous front pid for focus-change detection
	prevBlocked: boolean;
	prevTreeSample: { count: number; sample: string[] } | null;
	lastRepeatKey: string | null;
	lastRepeatAt: number;
	lastFullLogical: { width: number; height: number }; // logical size of the last full screenshot
}

const state: SessionState = {
	adapter: null,
	controller: new ProgressController(),
	cfg: loadConfig(),
	lastHash: null,
	lastWindows: [],
	knownWindows: null,
	widgetIndex: new Map(),
	lastRaster: { width: 0, height: 0 },
	lastLogical: { width: 0, height: 0 },
	round: 0,
	briefingDone: false,
	firstOfTask: true,
	actionsSinceFull: null,
	lastFrontPid: null,
	prevBlocked: false,
	prevTreeSample: null,
	lastRepeatKey: null,
	lastRepeatAt: 0,
	lastFullLogical: { width: 0, height: 0 },
};

async function getAdapter(ctx: ExtensionContext): Promise<PlatformAdapter | null> {
	if (state.adapter) return state.adapter;
	try {
		state.adapter = await createAdapter();
		return state.adapter;
	} catch (e) {
		ctx.ui.notify?.(
			`computer-use: no adapter for this platform — ${(e as Error).message} (see /cua doctor)`,
			"warning",
		);
		return null;
	}
}

function err(text: string): { content: Result; isError: true } {
	return { content: [{ type: "text", text: formatNotice(text) }], isError: true };
}

/**
 * Converts screenshot-raster coordinates to logical screen coordinates (Retina-aware,
 * PLAN v2 §3.1). ONLY valid for raster-space input (full observations / x/y params);
 * widget-tree centers are already logical (v3.1 §3 coordSpace) and must not be converted.
 */
function rasterToLogical(p: Point): Point {
	const rw = state.lastRaster.width || 1;
	const lw = state.lastLogical.width || rw;
	const rh = state.lastRaster.height || 1;
	const lh = state.lastLogical.height || rh;
	return { x: Math.round(p.x * (lw / rw)), y: Math.round(p.y * (lh / rh)) };
}

/** Element index → logical point (tree coordSpace). No raster conversion (PLAN §3). */
function elementToPoint(element: number): Point | null {
	const p = state.widgetIndex.get(Math.floor(element));
	return p ? { ...p } : null;
}

export default function computerUse(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		state.cfg = loadConfig();
	});

	// turn_end: reset no-progress/repeat detection + task-boundary observation state;
	// keep the cumulative action budget (PLAN v2 §6).
	pi.on("turn_end", async () => {
		state.controller.onTurnEnd();
		state.firstOfTask = true;
	});

	pi.registerTool({
		name: "computer",
		label: "Computer Use",
		// v3.1 §4.2 L0 (verbatim): identity + when-to-use + the single iron rule, ≤120 tokens.
		promptSnippet:
			"computer — see/control the desktop GUI. Widget-tree observations; screenshots on demand.",
		promptGuidelines: [
			"Use `computer` ONLY for desktop GUI automation the user asks for. Target elements by index " +
			"from the widget tree; call action:\"screenshot\" when you need to see pixels.",
		],
		description:
			"Desktop GUI automation. Observations default to a compact widget tree (no image cost); " +
			"screenshots are taken automatically at key moments or on demand. First call includes a " +
			"briefing; action:\"help\" returns the full manual.",
		namespace: {
			name: "computer-use",
			description: "Desktop GUI automation",
			instructions: MANUAL,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("screenshot"),
				Type.Literal("left_click"),
				Type.Literal("double_click"),
				Type.Literal("right_click"),
				Type.Literal("type"),
				Type.Literal("key"),
				Type.Literal("scroll"),
				Type.Literal("wait"),
				Type.Literal("list_windows"),
				Type.Literal("activate"),
				Type.Literal("help"),
			]),
			element: Type.Optional(Type.Number({ description: "Widget index from the last tree (preferred)" })),
			x: Type.Optional(Type.Number({ description: "Pixel x in last screenshot raster (fallback)" })),
			y: Type.Optional(Type.Number({ description: "Pixel y in last screenshot raster (fallback)" })),
			text: Type.Optional(Type.String({ description: 'type: text; key: combo like "cmd+c"' })),
			app: Type.Optional(Type.String({ description: "activate: app name or bundleId" })),
			direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
			amount: Type.Optional(Type.Number({ description: "scroll: wheel clicks (default 3)" })),
			ms: Type.Optional(Type.Number({ description: "wait: ms, 100..10000" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;

			// 0. L2 on-demand manual — no adapter, no gate, no observation cost (PLAN §4.4).
			if (action === "help") {
				return { content: [{ type: "text", text: MANUAL }] };
			}

			// 1. capabilities probe
			const adapter = await getAdapter(ctx);
			if (!adapter) {
				return err(`platform not supported — run /cua doctor for details`);
			}
			if (MUTATING.has(action) && !adapter.capabilities.mouseKeyboard) {
				return err(`input injection unavailable on ${adapter.capabilities.platform} — run /cua doctor`);
			}

			// 2. permission gate (B2: focus restore after Allow, PLAN §2.2)
			const gate = await gateAction(action, ctx, state.cfg, adapter);
			if (!gate.allowed) return err(gate.reason);

			// 3. progress controller precheck (hard stop, model-facing copy)
			const pre = state.controller.precheck(action);
			if (!pre.ok) return err(pre.reason);

			// target resolution (element preferred — logical space; x/y fallback — raster space)
			const resolveTarget = (): { target: string; point: Point; space: "raster" | "logical" } | { error: string } => {
				if (params.element !== undefined) {
					const el = Math.floor(params.element);
					const p = elementToPoint(el);
					if (!p) return { error: `element ${el} not found in the last widget tree; take a screenshot first` };
					return { target: `element:${el}`, point: p, space: "logical" };
				}
				if (params.x !== undefined && params.y !== undefined) {
					const x = Math.floor(params.x);
					const y = Math.floor(params.y);
					if (state.lastRaster.width && (x < 0 || y < 0 || x >= state.lastRaster.width || y >= state.lastRaster.height)) {
						return { error: `x/y (${x},${y}) outside the last screenshot ${state.lastRaster.width}x${state.lastRaster.height}` };
					}
					return { target: `${x},${y}`, point: { x, y }, space: "raster" };
				}
				return { error: `computer: ${action} requires (元素 index 或 x/y 二选一)` };
			};

			// 4. execute the action
			const prevHash = state.lastHash;
			const prevWindows = state.lastWindows;
			let target = action;
			try {
				switch (action) {
					case "screenshot":
					case "list_windows":
						break; // handled by the observation step below
					case "wait": {
						const ms = Math.min(10_000, Math.max(100, Math.floor(params.ms ?? 1000)));
						await new Promise((r) => setTimeout(r, ms));
						break;
					}
					case "activate": {
						const app = (params.app ?? "").trim();
						if (!app) return err(`computer: activate requires app (App 名或 bundleId)`);
						target = `activate:${app}`;
						await adapter.activateApp(app);
						break;
					}
					case "left_click":
					case "double_click":
					case "right_click": {
						const t = resolveTarget();
						if ("error" in t) return err(t.error);
						target = t.target;
						// PLAN §3: convert ONLY raster-space input; logical (element) points go through untouched.
						await adapter.moveAndClick(t.space === "raster" ? rasterToLogical(t.point) : t.point, action === "right_click" ? "right" : "left", action === "double_click");
						break;
					}
					case "type": {
						if (params.text === undefined) return err(`computer: type requires text`);
						target = `type "${params.text.slice(0, 24)}"`;
						await adapter.typeText(params.text);
						break;
					}
					case "key": {
						if (params.text === undefined) return err(`computer: key requires text (e.g. "cmd+c")`);
						target = `key ${params.text}`;
						await adapter.pressKey(params.text);
						break;
					}
					case "scroll": {
						const direction = params.direction ?? "down";
						const amount = Math.max(1, Math.floor(params.amount ?? 3));
						let at: Point | undefined;
						if (params.element !== undefined) at = elementToPoint(Math.floor(params.element));
						else if (params.x !== undefined && params.y !== undefined) at = rasterToLogical({ x: params.x, y: params.y });
						if (params.element !== undefined) target = `element:${Math.floor(params.element)}`;
						else if (params.x !== undefined && params.y !== undefined) target = `${Math.floor(params.x)},${Math.floor(params.y)}`;
						await adapter.scroll(direction, amount, at);
						break;
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return err(msg.slice(0, 200));
			}

			// 5. tiered observation (PLAN §1)
			let obs: Observation;
			if (action === "wait") {
				obs = {
					level: "minimal",
					coordSpace: "logical",
					windows: state.lastWindows,
					blocked: null,
					stateHash: state.lastHash ?? "",
				};
			} else {
				try {
					// 5a. gather cheap observation inputs first (windows, front app, AX tree)
					const windows = await adapter.listWindows();
					let frontApp: { appName: string; bundleId: string } | null = null;
					let frontPid: number | null = null;
					try {
						const f = await adapter.frontmostApp();
						if (f) {
							frontApp = { appName: f.appName, bundleId: f.bundleId };
							frontPid = f.pid;
						}
					} catch {
						/* fall back to window-list focus info */
					}
					let tree: WidgetNode | null = null;
					if (adapter.capabilities.a11y && adapter.a11yTree) {
						try {
							tree = await adapter.a11yTree();
						} catch {
							tree = null; // AX slow/unavailable ⇒ degrade (PLAN §3)
						}
					}
					const fp = tree ? treeFingerprint(tree) : "";
					const sample = tree ? treeSample(tree) : { count: 0, sample: [] };
					const treeChanged = tree ? treeChangedFraction(state.prevTreeSample ?? { count: 0, sample: [] }, sample) : 1;
					const focusChanged = state.lastFrontPid !== null && frontPid !== null && frontPid !== state.lastFrontPid;
					const now = Date.now();
					const repeatKey = `${action}:${target}`;
					const repeat = repeatKey === state.lastRepeatKey && now - state.lastRepeatAt < REPEAT_WINDOW_MS;
					state.lastRepeatKey = repeatKey;
					state.lastRepeatAt = now;

					// 5b. deterministic level decision (PLAN §1.2)
					const decision = decideLevel({
						action,
						firstOfTask: state.firstOfTask,
						actionsSinceFull: state.actionsSinceFull ?? Number.POSITIVE_INFINITY,
						focusChanged,
						prevBlocked: state.prevBlocked,
						treeChanged,
						hadPrevTree: state.prevTreeSample !== null && state.prevTreeSample.count > 0,
						repeat,
						a11yAvailable: Boolean(tree),
					});

					// 5c. screenshot only for full-level observations
					obs = {
						level: decision.level,
						coordSpace: "logical",
						windows,
						blocked: null,
						stateHash: fp,
						frontApp,
					};
					if (tree) {
						obs.widgetTree = tree;
						obs.treeFingerprint = fp;
						obs.treeNodeCount = sample.count;
					}
					if (decision.level === "full") {
						const shot = await adapter.screenshot();
						state.lastRaster = { width: shot.width, height: shot.height };
						try {
							const ss = await adapter.screenSize();
							state.lastLogical = ss.logical;
							state.lastFullLogical = ss.logical;
						} catch {
							/* keep previous logical size */
						}
						obs.screenshot = {
							base64: shot.jpeg.toString("base64"),
							width: shot.width,
							height: shot.height,
						};
						obs.coordSpace = "raster";
						obs.stateHash = shot.hash;
						state.actionsSinceFull = 0;
					} else {
						state.actionsSinceFull = (state.actionsSinceFull ?? 0) + 1;
						if (!tree) {
							// No a11y backend: degrade to minimal + hint (PLAN §3 fallback)
							obs.level = "minimal";
							obs.stateHash = state.lastHash ?? "";
						}
					}
					state.firstOfTask = false;
					state.lastFrontPid = frontPid ?? state.lastFrontPid;
					state.prevTreeSample = sample;
				} catch (e) {
					return err(`observation failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
				}
				state.widgetIndex = buildWidgetIndex(obs.widgetTree ?? null);
				state.knownWindows = new Set(obs.windows.map(windowKey));
			}

			// 6. record + blocked detection
			state.controller.record({
				action,
				target,
				stateHash: obs.stateHash,
				ok: true,
			});
			state.lastHash = obs.stateHash || state.lastHash;
			state.lastWindows = obs.windows;
			if (action !== "wait") {
				obs.blocked = detectBlocked({
					mutating: MUTATING.has(action),
					hash: obs.stateHash,
					prevHash,
					windows: obs.windows,
					prevWindows,
					knownWindows: state.knownWindows,
				});
			}
			state.prevBlocked = obs.blocked !== null;
			state.round += 1;

			// 7. assemble multimodal result (L1 briefing prepended once per session, PLAN §4.3)
			let text = formatObservation({
				action,
				target,
				ok: true,
				round: state.round,
				maxRounds: state.cfg.taskBudgets.maxActions,
				obs,
			});
			if (!state.briefingDone) {
				text = `${BRIEFING}\n\n${text}`;
				state.briefingDone = true;
			}
			const content: Result = [{ type: "text", text }];
			if (obs.screenshot) {
				content.push({
					type: "image",
					data: obs.screenshot.base64,
					mimeType: "image/jpeg",
				} as ImageContent);
			}
			return { content };
		},
	});

	pi.registerCommand("cua", {
		description: "computer-use: /cua [status|ask|bypass|clear|doctor]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const ui = ctx.ui;
			if (arg === "ask" || arg === "bypass") {
				state.cfg.mode = arg;
				saveConfig(state.cfg);
				ui.notify?.(`computer-use mode: ${arg}`, "info");
				return;
			}
			if (arg === "clear") {
				state.cfg.alwaysAllowed = [];
				state.cfg.mode = "ask";
				saveConfig(state.cfg);
				ui.notify?.("computer-use: alwaysAllowed cleared, mode back to ask", "info");
				return;
			}
			if (arg === "doctor") {
				const adapter = await getAdapter(ctx);
				if (!adapter) {
					ui.notify?.("computer-use: no adapter for this platform", "warning");
					return;
				}
				const report = await adapter.doctor();
				for (const item of report.items) {
					const mark = item.ok ? "✓" : "✗";
					const detail = item.detail ? ` — ${item.detail}` : "";
					ui.notify?.(`${mark} ${item.label}${detail}`, item.ok ? "info" : "warning");
					if (!item.ok && item.fix) ui.notify?.(`  fix: ${item.fix}`, "info");
				}
				return;
			}
			// status (default)
			const caps = state.adapter?.capabilities;
			const stats = state.controller.getStats();
			const matrix = caps
				? `platform: ${caps.platform} · screenshot: ${caps.screenshot ? "✓" : "✗"} · input: ${caps.mouseKeyboard ? "✓" : "✗"} · a11y: ${caps.a11y ? "✓" : "✗"} · clipboard: ${caps.clipboard ? "✓" : "✗"}`
				: "platform: not probed yet (first computer call probes it)";
			ui.notify?.(
				`computer-use status: mode=${state.cfg.mode} · actions ${stats.totalActions}/${stats.maxActions} · alwaysAllowed=[${state.cfg.alwaysAllowed.join(", ") || "—"}] · ${matrix}`,
				"info",
			);
			for (const note of caps?.notes ?? []) ui.notify?.(`note: ${note}`, "info");
			if (arg && arg !== "status") ui.notify?.(`Unknown arg '${arg}'. Use: status | ask | bypass | clear | doctor`, "warning");
		},
	});
}
