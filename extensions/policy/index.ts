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
 * Rules: ~/.pi/agent/policy.json
 *   [ { "tool": "bash", "match": "git push", "action": "ask", "reason": "publishes commits" } ]
 *   - tool: tool name, or "*" for any tool
 *   - match: substring or /regex/ (case-insensitive) tested against the call target
 *            (bash → command; write/edit → resolved path; others → JSON of params)
 *   - action: "allow" | "ask" | "deny"
 *   - reason: factual text shown in the prompt and written to the audit log
 *
 * Decision order: deny > ask > allow > default-allow. First match wins per tier.
 * Audit: ~/.pi/agent/policy-audit.log — one line per decision.
 *
 * Commands: /policy [list | test "<target>" | audit [n] | add <tool> <action> <match> [reason]]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Action = "allow" | "ask" | "deny";

interface Rule {
	tool: string;
	match: string;
	action: Action;
	reason?: string;
}

const RULES_PATH = join(homedir(), ".pi", "agent", "policy.json");
const AUDIT_PATH = join(homedir(), ".pi", "agent", "policy-audit.log");

/** Defaults are written to the config file on first run so they stay editable. */
const DEFAULT_RULES: Rule[] = [
	{ tool: "bash", match: "/\\brm\\s+-[a-z]*[rf]/i", action: "deny", reason: "recursive/forced delete" },
	{ tool: "bash", match: "/\\bsudo\\b/i", action: "deny", reason: "privilege escalation" },
	{ tool: "bash", match: "/\\bcurl\\b[^|]*\\|\\s*(ba)?sh/i", action: "deny", reason: "piping a download into a shell" },
	{ tool: "bash", match: "git push", action: "ask", reason: "publishes commits to a remote" },
	{ tool: "bash", match: "npm publish", action: "ask", reason: "publishes a package" },
	{ tool: "bash", match: "/\\bchmod\\b.*777/i", action: "ask", reason: "world-writable permissions" },
	{ tool: "write", match: "outside-cwd", action: "ask", reason: "writes outside the session root" },
	{ tool: "edit", match: "outside-cwd", action: "ask", reason: "writes outside the session root" },
];

function loadRules(): { rules: Rule[]; created: boolean } {
	if (!existsSync(RULES_PATH)) {
		writeFileSync(RULES_PATH, `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`, "utf8");
		return { rules: DEFAULT_RULES, created: true };
	}
	try {
		const raw = JSON.parse(readFileSync(RULES_PATH, "utf8"));
		if (!Array.isArray(raw)) throw new Error("rules file is not an array");
		const rules: Rule[] = [];
		for (const [i, r] of raw.entries()) {
			if (typeof r !== "object" || r === null) throw new Error(`rule ${i} is not an object`);
			const rule = r as Record<string, unknown>;
			if (typeof rule.tool !== "string") throw new Error(`rule ${i} missing tool`);
			if (typeof rule.match !== "string") throw new Error(`rule ${i} missing match`);
			if (rule.action !== "allow" && rule.action !== "ask" && rule.action !== "deny") throw new Error(`rule ${i} has invalid action`);
			rules.push({ tool: rule.tool, match: rule.match, action: rule.action, reason: typeof rule.reason === "string" ? rule.reason : undefined });
		}
		return { rules, created: false };
	} catch (e) {
		console.error(`policy: ${RULES_PATH} is unusable (${e instanceof Error ? e.message : e}); falling back to defaults`);
		return { rules: DEFAULT_RULES, created: false };
	}
}

function saveRules(rules: Rule[]): void {
	writeFileSync(RULES_PATH, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
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
}

export function decide(rules: Rule[], tool: string, target: string, cwd: string): Decision {
	const hit = (action: Action) => rules.find((r) => r.action === action && matches(r, tool, target, cwd));
	const denied = hit("deny");
	if (denied) return { action: "deny", rule: denied, source: "rule" };
	const asked = hit("ask");
	if (asked) return { action: "ask", rule: asked, source: "rule" };
	const allowed = hit("allow");
	if (allowed) return { action: "allow", rule: allowed, source: "rule" };
	return { action: "allow", source: "default" };
}

function audit(tool: string, target: string, decision: Decision, outcome: string): void {
	const summary = target.replace(/\s+/g, " ").slice(0, 120);
	const line = [
		new Date().toISOString(),
		tool,
		summary,
		outcome,
		decision.rule ? `${decision.rule.action}:${decision.rule.match}` : "-",
		decision.source,
	].join(" | ");
	try {
		appendFileSync(AUDIT_PATH, `${line}\n`, "utf8");
	} catch {
		/* audit is best-effort; the decision itself already applied */
	}
}

export default function (pi: ExtensionAPI) {
	let { rules, created } = loadRules();

	// `always allow` from the prompt appends an allow rule so the decision is visible in the config.
	const rememberAllow = (tool: string, target: string, reason?: string) => {
		// keep the stored match narrow: the exact command/path that was approved
		rules.push({ tool, match: target.slice(0, 200), action: "allow", reason: reason ?? "always-allow from prompt" });
		saveRules(rules);
	};

	pi.on("session_start", (_event, ctx) => {
		if (created) ctx.ui.notify(`policy: created default rules at ${RULES_PATH}`, "info");
	});

	pi.on("tool_call", async (event, ctx) => {
		// nested calls carry the parent id; they still go through the same rules
		const tool = event.toolName;
		const params = (event.input ?? {}) as Record<string, unknown>;
		const target = targetOf(tool, params, ctx.cwd);
		const decision = decide(rules, tool, target, ctx.cwd);

		if (decision.action === "deny") {
			audit(tool, target, decision, "denied");
			return { block: true, reason: `policy denied (${decision.rule?.reason ?? "rule"}): ${target.slice(0, 160)}` };
		}
		if (decision.action === "ask") {
			const ok = await ctx.ui.confirm(
				`policy: allow this ${tool} call?`,
				`${target.slice(0, 400)}\n\nreason: ${decision.rule?.reason ?? "(no rule reason)"}`,
			);
			audit(tool, target, decision, ok ? "allowed" : "rejected");
			if (!ok) return { block: true, reason: `policy: not approved by user — ${target.slice(0, 160)}` };
			return;
		}
		audit(tool, target, decision, "allowed");
		return;
	});

	pi.registerCommand("policy", {
		description: "Permission rules: /policy [list | test <target> | audit [n] | add <tool> <action> <match> [reason] | always <tool> <target>]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [cmd, ...rest] = tokens;
			switch (cmd) {
				case undefined:
				case "list": {
					const lines = rules.map(
						(r, i) => `${String(i + 1).padStart(2)}. ${r.action.toUpperCase().padEnd(5)} ${r.tool.padEnd(8)} ${r.match}${r.reason ? `  — ${r.reason}` : ""}`,
					);
					ctx.ui.notify(`rules (${RULES_PATH}):\n${lines.join("\n")}`, "info");
					return;
				}
				case "test": {
					const target = rest.join(" ");
					if (!target) return ctx.ui.notify("usage: /policy test <command or path>", "warning");
					const d = decide(rules, target.startsWith("/") ? "write" : "bash", target, ctx.cwd);
					ctx.ui.notify(
						`${d.action.toUpperCase()} (${d.source}${d.rule ? `, rule: ${d.rule.action} ${d.rule.match}` : ""})${d.rule?.reason ? ` — ${d.rule.reason}` : ""}`,
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
					rules.push({ tool, action, match, reason: reasonParts.join(" ") || undefined });
					saveRules(rules);
					ctx.ui.notify(`rule added: ${action} ${tool} ${match}`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown arg '${cmd}'. Use: list | test <target> | audit [n] | add <tool> <action> <match> [reason]`, "warning");
			}
		},
	});
}
