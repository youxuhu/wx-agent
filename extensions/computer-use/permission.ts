/**
 * permission.ts — permission gate + computer-use.json persistence (PLAN §7, sandbox-isomorphic).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FrontAppInfo, PlatformAdapter } from "./platform";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "computer-use.json");

export interface CuaConfig {
	mode: "ask" | "bypass";
	alwaysAllowed: string[];
	taskBudgets: { maxActions: number; maxStall: number };
}

export function defaultConfig(): CuaConfig {
	return { mode: "ask", alwaysAllowed: [], taskBudgets: { maxActions: 60, maxStall: 3 } };
}

export function loadConfig(): CuaConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<CuaConfig>;
			const cfg = defaultConfig();
			if (raw.mode === "bypass" || raw.mode === "ask") cfg.mode = raw.mode;
			if (Array.isArray(raw.alwaysAllowed)) {
				cfg.alwaysAllowed = raw.alwaysAllowed.filter((a): a is string => typeof a === "string");
			}
			if (raw.taskBudgets && typeof raw.taskBudgets === "object") {
				if (typeof raw.taskBudgets.maxActions === "number") cfg.taskBudgets.maxActions = raw.taskBudgets.maxActions;
				if (typeof raw.taskBudgets.maxStall === "number") cfg.taskBudgets.maxStall = raw.taskBudgets.maxStall;
			}
			return cfg;
		}
	} catch {
		/* fall through to defaults */
	}
	return defaultConfig();
}

export function saveConfig(cfg: CuaConfig): void {
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		/* best-effort persistence */
	}
}

/** Actions that never require confirmation (PLAN §3.2 step 2). */
const OBSERVATION_ACTIONS = new Set(["screenshot", "wait", "list_windows"]);

export type GateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * gateAction — ask/bypass gate for mutating actions.
 * Observation actions always pass. In ask mode with an un-allowlisted action, prompts via
 * ctx.ui.select (Allow once / Always allow / Deny). Without a UI (print mode) acts as Deny.
 *
 * B2 (PLAN §2.2): before prompting, snapshot the front app (adapter.frontmostApp); after an
 * Allow, restore it (adapter.activateApp) so the confirmation dialog does not leave the
 * following keystrokes in the terminal. Deny/bypass paths do not touch focus.
 */
export async function gateAction(
	action: string,
	ctx: ExtensionContext,
	cfg: CuaConfig,
	adapter?: PlatformAdapter,
): Promise<GateResult> {
	if (OBSERVATION_ACTIONS.has(action)) return { allowed: true };
	if (cfg.mode === "bypass") return { allowed: true };
	if (cfg.alwaysAllowed.includes(action)) return { allowed: true };
	if (!ctx.ui || typeof ctx.ui.select !== "function") {
		return { allowed: false, reason: "computer: 用户拒绝该动作 (非交互模式需 /cua bypass)" };
	}
	let prev: FrontAppInfo | null = null;
	if (adapter?.frontmostApp) {
		try {
			prev = await adapter.frontmostApp();
		} catch {
			/* focus restore is best-effort */
		}
	}
	const choice = await ctx.ui.select(`computer-use：允许 ${action}？`, ["Allow once", "Always allow", "Deny"]);
	if (choice === "Always allow") {
		if (!cfg.alwaysAllowed.includes(action)) cfg.alwaysAllowed.push(action);
		saveConfig(cfg);
		if (prev && adapter?.activateApp) await restoreFocus(adapter, prev);
		return { allowed: true };
	}
	if (choice === "Allow once") {
		if (prev && adapter?.activateApp) await restoreFocus(adapter, prev);
		return { allowed: true };
	}
	return { allowed: false, reason: "computer: 用户拒绝该动作" };
}

/** Best-effort focus restore after the confirmation dialog (PLAN §2.2 step 2). */
async function restoreFocus(adapter: PlatformAdapter, prev: FrontAppInfo): Promise<void> {
	try {
		await adapter.activateApp(prev.bundleId || prev.appName || String(prev.pid));
	} catch {
		/* never fail the action because of a focus restore miss */
	}
}
