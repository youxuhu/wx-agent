/**
 * computer-use — see and control the desktop GUI from pi (PLAN v2, Phase 1: macOS MVP).
 *
 * Registers the single `computer` tool (screenshot / click / type / key / scroll / wait /
 * list_windows) plus the /cua command (status | ask | bypass | clear | doctor).
 * Every mutating action passes the permission gate (~/.pi/agent/computer-use.json) and the
 * deterministic progress controller (budget 60 actions, 3-step stall stop, loop detection).
 * Observations return a screenshot (JPEG <=1280, q60) + window list + dHash state; the a11y
 * widget tree lands in Phase 2.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ImageContent, TextContent } from "@earendil-works/pi-coding-agent";
import { ProgressController } from "./controller";
import { buildWidgetIndex, detectBlocked, mergeTree, windowKey, type Observation } from "./gate";
import { gateAction, loadConfig, saveConfig, type CuaConfig } from "./permission";
import { createAdapter, type PlatformAdapter, type Point, type WindowInfo } from "./platform";
import { formatNotice, formatObservation } from "./ui";

type Result = Array<TextContent | ImageContent>;

const MUTATING = new Set(["left_click", "double_click", "right_click", "type", "key", "scroll"]);

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

/** Converts screenshot-raster coordinates to logical screen coordinates (Retina-aware, PLAN §3.1). */
function rasterToLogical(p: Point): Point {
	const rw = state.lastRaster.width || 1;
	const lw = state.lastLogical.width || rw;
	const rh = state.lastRaster.height || 1;
	const lh = state.lastLogical.height || rh;
	return { x: Math.round(p.x * (lw / rw)), y: Math.round(p.y * (lh / rh)) };
}

async function observe(adapter: PlatformAdapter, ctx: ExtensionContext): Promise<Observation> {
	const shot = await adapter.screenshot();
	state.lastRaster = { width: shot.width, height: shot.height };
	try {
		const ss = await adapter.screenSize();
		state.lastLogical = ss.logical;
	} catch {
		/* keep previous logical size */
	}
	let windows: WindowInfo[] = [];
	try {
		windows = await adapter.listWindows();
	} catch (e) {
		ctx.ui.notify?.(`computer-use: list_windows failed: ${(e as Error).message}`, "warning");
	}
	return {
		screenshot: {
			base64: shot.jpeg.toString("base64"),
			width: shot.width,
			height: shot.height,
		},
		widgetTree: mergeTree(), // TODO(Phase 2): merge adapter.a11yTree() per PLAN §5.4
		windows,
		blocked: null,
		stateHash: shot.hash,
	};
}

export default function computerUse(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		state.cfg = loadConfig();
	});

	// turn_end: reset no-progress/repeat detection, keep the cumulative action budget (PLAN §6).
	pi.on("turn_end", async () => {
		state.controller.onTurnEnd();
	});

	pi.registerTool({
		name: "computer",
		label: "Computer Use",
		promptSnippet:
			"computer — see and control the desktop GUI: screenshot, " +
			"mouse, keyboard, windows. Element-index targeting preferred over pixels.",
		promptGuidelines: [
			"Use `computer` ONLY for desktop GUI automation the user asks for; never as a general automation runtime.",
			"ALWAYS call computer{screenshot} first, then target elements by `element` index from the widget tree; use x/y pixels only when no element matches. x/y must lie inside the last screenshot's width/height.",
			"After any mutating action the result already includes a fresh screenshot — do not take an extra screenshot to verify.",
			"Stop and report when the tool returns a no-progress/blocked error; do not repeat the same action more than twice.",
		],
		description:
			"See and control the user's desktop GUI (screenshot, mouse, keyboard, windows). " +
			"Observations return a screenshot plus an indexed widget tree; target elements by index. " +
			"Subject to the /cua permission gate.",
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
			]),
			element: Type.Optional(
				Type.Number({ description: "Widget tree index from the last observation (preferred)" }),
			),
			x: Type.Optional(Type.Number({ description: "Pixel x in last screenshot raster (fallback)" })),
			y: Type.Optional(Type.Number({ description: "Pixel y in last screenshot raster (fallback)" })),
			text: Type.Optional(
				Type.String({ description: 'type: text to type; key: key combo like "cmd+c" or "enter"' }),
			),
			direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
			amount: Type.Optional(Type.Number({ description: "scroll: wheel clicks (default 3)" })),
			ms: Type.Optional(Type.Number({ description: "wait: milliseconds, 100..10000" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;

			// 1. capabilities probe
			const adapter = await getAdapter(ctx);
			if (!adapter) {
				return err(`platform not supported — run /cua doctor for details`);
			}
			if (MUTATING.has(action) && !adapter.capabilities.mouseKeyboard) {
				return err(`input injection unavailable on ${adapter.capabilities.platform} — run /cua doctor`);
			}

			// 2. permission gate
			const gate = await gateAction(action, ctx, state.cfg);
			if (!gate.allowed) return err(gate.reason);

			// 3. progress controller precheck (hard stop, model-facing copy)
			const pre = state.controller.precheck(action);
			if (!pre.ok) return err(pre.reason);

			// target resolution (element preferred, x/y fallback)
			const resolveTarget = (): { target: string; point: Point } | { error: string } => {
				if (params.element !== undefined) {
					const c = state.widgetIndex.get(Math.floor(params.element));
					if (!c) return { error: `element ${Math.floor(params.element)} not found in the last widget tree; take a screenshot first` };
					return { target: `element:${Math.floor(params.element)}`, point: c };
				}
				if (params.x !== undefined && params.y !== undefined) {
					const x = Math.floor(params.x);
					const y = Math.floor(params.y);
					if (state.lastRaster.width && (x < 0 || y < 0 || x >= state.lastRaster.width || y >= state.lastRaster.height)) {
						return { error: `x/y (${x},${y}) outside the last screenshot ${state.lastRaster.width}x${state.lastRaster.height}` };
					}
					return { target: `${x},${y}`, point: { x, y } };
				}
				return { error: `computer: ${action} requires (元素 index 或 x/y 二选一)` };
			};

			// 4. execute the action
			const prevHash = state.lastHash;
			const prevWindows = state.lastWindows;
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
					case "left_click":
					case "double_click":
					case "right_click": {
						const t = resolveTarget();
						if ("error" in t) return err(t.error);
						await adapter.moveAndClick(
							rasterToLogical(t.point),
							action === "right_click" ? "right" : "left",
							action === "double_click",
						);
						break;
					}
					case "type": {
						if (params.text === undefined) return err(`computer: type requires text`);
						await adapter.typeText(params.text);
						break;
					}
					case "key": {
						if (params.text === undefined) return err(`computer: key requires text (e.g. "cmd+c")`);
						await adapter.pressKey(params.text);
						break;
					}
					case "scroll": {
						const direction = params.direction ?? "down";
						const amount = Math.max(1, Math.floor(params.amount ?? 3));
						let at: Point | undefined;
						if (params.x !== undefined && params.y !== undefined) at = rasterToLogical({ x: params.x, y: params.y });
						await adapter.scroll(direction, amount, at);
						break;
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return err(msg.slice(0, 200));
			}

			// 5. auto-observation after every non-wait action
			let obs: Observation;
			if (action === "wait") {
				obs = {
					windows: state.lastWindows,
					blocked: null,
					stateHash: state.lastHash ?? "",
				};
			} else {
				try {
					obs = await observe(adapter, ctx);
				} catch (e) {
					return err(`observation failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
				}
				state.widgetIndex = buildWidgetIndex(obs.widgetTree);
				state.knownWindows = new Set(obs.windows.map(windowKey));
			}

			// 6. record + blocked detection
			const target = params.element !== undefined ? `element:${Math.floor(params.element)}` : params.x !== undefined ? `${Math.floor(params.x)},${Math.floor(params.y)}` : action;
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
			state.round += 1;

			// 7. assemble multimodal result
			const content: Result = [
				{
					type: "text",
					text: formatObservation({
						action,
						target,
						ok: true,
						round: state.round,
						maxRounds: state.cfg.taskBudgets.maxActions,
						obs,
					}),
				},
			];
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
