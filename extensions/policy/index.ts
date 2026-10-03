/**
 * policy — intent-layer permission rules + audit trail.
 *
 * Classifies tool calls before they run and either allows, asks, or denies them,
 * then records the decision. This is the layer that keeps the per-call approval
 * ability after the sandbox extension moved to kernel-enforced filesystem policy
 * (the OS sandbox cannot prompt; it denies).
 *
 * Scope split: policy decides intent (what the call is about); the OS sandbox
 * enforces effects (what the process can touch). Policy never duplicates the
 * sandbox's filesystem enforcement for bash.
 *
 * Modes (how much approval you want):
 *   auto    ask-rules are auto-allowed (still audited). Fewest prompts. Deny rules always hold.
 *   normal  ask-rules prompt. Default.
 *   strict  like normal, but calls that no rule matches also prompt (default-allow → ask).
 *
 * The approval prompt itself offers mode switching ("fewer prompts"), so you do not
 * have to leave the flow to change it.
 *
 * Config: ~/.pi/agent/policy.json
 *   { "mode": "normal", "rules": [ { "tool": "bash", "match": "git push", "action": "ask", "reason": "…" } ] }
 *   - tool: tool name, or "*" for any tool
 *   - match: substring, /regex/ (case-insensitive), or "outside-cwd"
 *   - action: "allow" | "ask" | "deny"
 * Legacy shape (a bare array of rules) is migrated automatically.
 *
 * Decision order: deny > ask > allow > default-allow. First match wins per tier.
 * Audit: ~/.pi/agent/policy-audit.log — one line per decision.
 *
 * Commands: /policy [status | mode auto|normal|strict | list | test <target> | audit [n] | add <tool> <action> <match> [reason]]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Action = "allow" | "ask" | "deny";
export type Mode = "auto" | "normal" | "strict";

interface Rule {
	tool: string;
	match: string;
	action: Action;
	reason?: string;
}

interface PolicyConfig {
	mode: Mode;
	rules: Rule[];
}

const RULES_PATH = join(homedir(), ".pi", "agent", "policy.json");
const AUDIT_PATH = join(homedir(), ".pi", "agent", "policy-audit.log");

/** Defaults are written to the config file on first run so they stay editable. */
const DEFAULT_RULES: Rule[] = [
	// anchored at a command boundary (start of line, or after ; & |) so that the text
	// "rm -rf" inside a heredoc, comment or string literal does not false-positive
	{ tool: "bash", match: "/(^|[;&|]\\s*)rm\\s+-[a-zA-Z]*[rf]/i", action: "deny", reason: "recursive/forced delete" },
	{ tool: "bash", match: "/(^|[;&|]\\s*)sudo\\b/i", action: "deny", reason: "privilege escalation" },
	{ tool: "bash", match: "/(^|[;&|]\\s*)curl\\b[^|]*\\|\\s*(ba)?sh/i", action: "deny", reason: "piping a download into a shell" },
	{ tool: "bash", match: "/^\\s*git\\s+push\\b/i", action: "ask", reason: "publishes commits to a remote" },
	{ tool: "bash", match: "/^\\s*npm\\s+publish\\b/i", action: "ask", reason: "publishes a package" },
	{ tool: "bash", match: "/(^|[;&|]\\s*)chmod\\b.*777/i", action: "ask", reason: "world-writable permissions" },
	{ tool: "write", match: "outside-cwd", action: "ask", reason: "writes outside the session root" },
	{ tool: "edit", match: "outside-cwd", action: "ask", reason: "writes outside the session root" },
];

/** Legacy default patterns replaced by the anchored ones above. */
const LEGACY_DEFAULT_MATCHES: Record<string, string> = {
	"/\\brm\\s+-[a-z]*[rf]/i": "/(^|[;&|]\\s*)rm\\s+-[a-zA-Z]*[rf]/i",
	"/\\bsudo\\b/i": "/(^|[;&|]\\s*)sudo\\b/i",
	"/\\bcurl\\b[^|]*\\|\\s*(ba)?sh/i": "/(^|[;&|]\\s*)curl\\b[^|]*\\|\\s*(ba)?sh/i",
	"/\\bchmod\\b.*777/i": "/(^|[;&|]\\s*)chmod\\b.*777/i",
	"git push": "/^\\s*git\\s+push\\b/i",
	"npm publish": "/^\\s*npm\\s+publish\\b/i",
};

const MODES: Mode[] = ["auto", "normal", "strict"];

function parseRules(raw: unknown): Rule[] {
	if (!Array.isArray(raw)) throw new Error("rules is not an array");
	const rules: Rule[] = [];
	for (const [i, r] of raw.entries()) {
		if (typeof r !== "object" || r === null) throw new Error(`rule ${i} is not an object`);
		const rule = r as Record<string, unknown>;
		if (typeof rule.tool !== "string") throw new Error(`rule ${i} missing tool`);
		if (typeof rule.match !== "string") throw new Error(`rule ${i} missing match`);
		if (rule.action !== "allow" && rule.action !== "ask" && rule.action !== "deny") throw new Error(`rule ${i} has invalid action`);
		rules.push({ tool: rule.tool, match: rule.match, action: rule.action, reason: typeof rule.reason === "string" ? rule.reason : undefined });
	}
	return rules;
}

function loadConfig(): { config: PolicyConfig; created: boolean } {
	if (!existsSync(RULES_PATH)) {
		const config: PolicyConfig = { mode: "normal", rules: DEFAULT_RULES };
		writeFileSync(RULES_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		return { config, created: true };
	}
	try {
		const raw = JSON.parse(readFileSync(RULES_PATH, "utf8")) as unknown;
		let config: PolicyConfig;
		if (Array.isArray(raw)) {
			// legacy bare-array shape → object with a mode
			config = { mode: "normal", rules: parseRules(raw) };
		} else {
			const o = raw as Record<string, unknown>;
			const mode = MODES.includes(o.mode as Mode) ? (o.mode as Mode) : "normal";
			config = { mode, rules: parseRules(o.rules) };
		}
		// upgrade the unanchored legacy default patterns in place (they false-positived on
		// the literal text inside heredocs/strings); user-written matches are left alone
		let upgraded = 0;
		for (const rule of config.rules) {
			const replacement = LEGACY_DEFAULT_MATCHES[rule.match];
			if (replacement) {
				rule.match = replacement;
				upgraded++;
			}
		}
		if (upgraded > 0) saveConfig(config);
		return { config, created: false };
	} catch (e) {
		console.error(`policy: ${RULES_PATH} is unusable (${e instanceof Error ? e.message : e}); falling back to defaults`);
		return { config: { mode: "normal", rules: DEFAULT_RULES }, created: false };
	}
}

function saveConfig(config: PolicyConfig): void {
	writeFileSync(RULES_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Target text a rule is matched against. */
function targetOf(tool: string, params: Record<string, unknown>, cwd: string): string {
	if (tool === "bash" && typeof params.command === "string") return params.command;
	const path = params.path ?? params.file_path ?? params.filePath;
	if (typeof path === "string" && path) return isAbsolute(path) ? path : resolve(cwd, path);
	try {
		return JSON.stringify(params);
	} catch {
		return "";
	}
}

function matches(rule: Rule, tool: string, target: string, cwd: string): boolean {
	if (rule.tool !== "*" && rule.tool !== tool) return false;
	if (rule.match === "outside-cwd") {
		const p = target;
		if (!p || !p.startsWith("/")) return false;
		const root = resolve(cwd);
		return !p.startsWith(root.endsWith("/") ? root : `${root}/`) && p !== root;
	}
	const m = rule.match.match(/^\/(.*)\/([a-z]*)$/i);
	if (m) {
		try {
			return new RegExp(m[1], m[2].includes("i") ? m[2] : `${m[2]}i`).test(target);
		} catch {
			return false;
		}
	}
	return target.toLowerCase().includes(rule.match.toLowerCase());
}

export interface Decision {
	action: Action;
	rule?: Rule;
	source: "rule" | "default";
	/** set when the mode (not a rule) decided */
	modeApplied?: Mode;
}

/** Rule tier only: deny > ask > allow > default-allow. */
function decideByRules(rules: Rule[], tool: string, target: string, cwd: string): Decision {
	const hit = (action: Action) => rules.find((r) => r.action === action && matches(r, tool, target, cwd));
	const denied = hit("deny");
	if (denied) return { action: "deny", rule: denied, source: "rule" };
	const asked = hit("ask");
	if (asked) return { action: "ask", rule: asked, source: "rule" };
	const allowed = hit("allow");
	if (allowed) return { action: "allow", rule: allowed, source: "rule" };
	return { action: "allow", source: "default" };
}

/** Rule tier plus the current mode. Deny always holds. */
export function decide(rules: Rule[], tool: string, target: string, cwd: string, mode: Mode = "normal"): Decision {
	const base = decideByRules(rules, tool, target, cwd);
	if (mode === "auto" && base.action === "ask") return { ...base, action: "allow", modeApplied: "auto" };
	if (mode === "strict" && base.action === "allow" && base.source === "default") return { ...base, action: "ask", modeApplied: "strict" };
	return base;
}

function audit(tool: string, target: string, decision: Decision, outcome: string): void {
	const summary = target.replace(/\s+/g, " ").slice(0, 120);
	const line = [
		new Date().toISOString(),
		tool,
		summary,
		outcome,
		decision.rule ? `${decision.rule.action}:${decision.rule.match}` : "-",
		decision.modeApplied ? `${decision.source}(${decision.modeApplied})` : decision.source,
	].join(" | ");
	try {
		appendFileSync(AUDIT_PATH, `${line}\n`, "utf8");
	} catch {
		/* audit is best-effort; the decision itself already applied */
	}
}

const PROMPT_ALLOW_ONCE = "Allow once";
const PROMPT_FEWER = "Switch to auto mode (fewer prompts, this session)";
const PROMPT_DENY = "Deny";

export default function (pi: ExtensionAPI) {
	let { config, created } = loadConfig();
	/** session override set from the approval prompt; `/policy mode` writes the config */
	let sessionMode: Mode | null = null;
	const modeOf = () => sessionMode ?? config.mode;

	pi.on("session_start", (_event, ctx) => {
		sessionMode = null;
		if (created) ctx.ui.notify(`policy: created default rules at ${RULES_PATH}`, "info");
		ctx.ui.setStatus("policy", ctx.ui.theme.fg("muted", `policy:${modeOf()}`));
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		const params = (event.input ?? {}) as Record<string, unknown>;
		const target = targetOf(tool, params, ctx.cwd);
		const decision = decide(config.rules, tool, target, ctx.cwd, modeOf());

		if (decision.action === "deny") {
			audit(tool, target, decision, "denied");
			return { block: true, reason: `policy denied (${decision.rule?.reason ?? "rule"}): ${target.slice(0, 160)}` };
		}
		if (decision.action === "allow" && decision.modeApplied === "auto") {
			audit(tool, target, decision, "allowed (auto mode)");
			return;
		}
		if (decision.action === "ask") {
			const shortTarget = target.replace(/\s+/g, " ").slice(0, 110);
			const reason = decision.rule?.reason ?? "no rule matched (strict mode)";
			const alwaysLabel = `Always allow: ${target.replace(/\s+/g, " ").slice(0, 60)}`;
			const choice = await ctx.ui.select(
				`policy[${modeOf()}] ${tool} — ${shortTarget} — ${reason}`,
				[PROMPT_ALLOW_ONCE, alwaysLabel, PROMPT_FEWER, PROMPT_DENY],
			);
			if (choice === PROMPT_FEWER) {
				sessionMode = "auto";
				ctx.ui.setStatus("policy", ctx.ui.theme.fg("muted", "policy:auto"));
				ctx.ui.notify("policy: auto mode for this session — ask-rules no longer prompt (deny rules still hold). /policy mode auto to persist.", "info");
				audit(tool, target, decision, "allowed (switched to auto)");
				return;
			}
			if (choice === alwaysLabel) {
				config.rules.push({ tool, match: target.slice(0, 200), action: "allow", reason: "always-allow from prompt" });
				saveConfig(config);
				audit(tool, target, decision, "allowed (rule added)");
				return;
			}
			if (choice === PROMPT_ALLOW_ONCE) {
				audit(tool, target, decision, "allowed");
				return;
			}
			audit(tool, target, decision, "rejected");
			return { block: true, reason: `policy: not approved by user — ${target.slice(0, 160)}` };
		}
		audit(tool, target, decision, "allowed");
		return;
	});

	pi.registerCommand("policy", {
		description: "Permission rules: /policy [status | mode auto|normal|strict | list | test <target> | audit [n] | add <tool> <action> <match> [reason]]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [cmd, ...rest] = tokens;
			switch (cmd) {
				case "mode": {
					const wanted = rest[0] as Mode | undefined;
					if (!wanted || !MODES.includes(wanted)) {
						return ctx.ui.notify(`mode: ${modeOf()}${sessionMode ? " (session override)" : ""}; usage: /policy mode auto|normal|strict`, "warning");
					}
					config.mode = wanted;
					sessionMode = null;
					saveConfig(config);
					ctx.ui.setStatus("policy", ctx.ui.theme.fg("muted", `policy:${wanted}`));
					const note =
						wanted === "auto"
							? "ask-rules are auto-allowed and audited; deny rules still block"
							: wanted === "strict"
								? "calls no rule matches also prompt"
								: "ask-rules prompt";
					ctx.ui.notify(`policy mode set to ${wanted} — ${note}`, "info");
					return;
				}
				case undefined:
				case "status": {
					ctx.ui.notify(
						[
							`mode: ${modeOf()}${sessionMode ? " (session override; /policy mode <m> to persist)" : ""}`,
							`rules: ${config.rules.length} in ${RULES_PATH}`,
							`audit: ${AUDIT_PATH}`,
						].join("\n"),
						"info",
					);
					return;
				}
				case "list": {
					const lines = config.rules.map(
						(r, i) => `${String(i + 1).padStart(2)}. ${r.action.toUpperCase().padEnd(5)} ${r.tool.padEnd(8)} ${r.match}${r.reason ? `  — ${r.reason}` : ""}`,
					);
					ctx.ui.notify(`mode: ${modeOf()}\nrules (${RULES_PATH}):\n${lines.join("\n")}`, "info");
					return;
				}
				case "test": {
					const target = rest.join(" ");
					if (!target) return ctx.ui.notify("usage: /policy test <command or path>", "warning");
					const d = decide(config.rules, target.startsWith("/") ? "write" : "bash", target, ctx.cwd, modeOf());
					ctx.ui.notify(
						`${d.action.toUpperCase()} (${d.source}${d.modeApplied ? `, mode ${d.modeApplied}` : ""}${d.rule ? `, rule: ${d.rule.action} ${d.rule.match}` : ""})${d.rule?.reason ? ` — ${d.rule.reason}` : ""}`,
						"info",
					);
					return;
				}
				case "audit": {
					const n = Math.max(1, Math.min(50, Number(rest[0] ?? 10) || 10));
					if (!existsSync(AUDIT_PATH)) return ctx.ui.notify("audit log is empty", "info");
					const lines = readFileSync(AUDIT_PATH, "utf8").trim().split("\n").slice(-n);
					ctx.ui.notify(`audit (last ${lines.length}):\n${lines.join("\n")}`, "info");
					return;
				}
				case "add": {
					const [tool, action, match, ...reasonParts] = rest;
					if (!tool || !action || !match || (action !== "allow" && action !== "ask" && action !== "deny")) {
						return ctx.ui.notify("usage: /policy add <tool> <allow|ask|deny> <match> [reason]", "warning");
					}
					config.rules.push({ tool, action, match, reason: reasonParts.join(" ") || undefined });
					saveConfig(config);
					ctx.ui.notify(`rule added: ${action} ${tool} ${match}`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown arg '${cmd}'. Use: status | mode <m> | list | test <target> | audit [n] | add <tool> <action> <match> [reason]`, "warning");
			}
		},
	});
}
