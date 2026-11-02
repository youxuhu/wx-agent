/**
 * plan-switch — OpenCode-style Plan ⇄ Build role toggle for Pi.
 *
 * alt+tab / /plan / /build switch between:
 *   - plan:  read-only research role. Writes a decision-complete plan to
 *            PLAN.md (the ONLY file it may create or modify).
 *   - build: normal full-tool development role (the default on startup),
 *            augmented with a lightweight "project change memory" loop.
 *
 * Build memory loop (instruction-driven; every AGENTS.md write happens in
 * the build role, never in the read-only plan role):
 *   1. On ENTERING build, the injected BUILD_INSTRUCTIONS tell the agent to
 *      first read the project AGENTS.md "Change Log" memory so it does not
 *      repeat past stale tries / expensive mistakes.
 *   2. Mid-build, when the agent hits and clears a blocker, it records one
 *      short issue bullet in the Change Log.
 *   3. When THIS build finishes implementing the plan in PLAN.md, the agent
 *      writes a one-line-per-item change record into AGENTS.md: purpose +
 *      simple approach (no code detail), which together mark the previous
 *      plan as addressed. It may rename PLAN.md -> PLAN.md.done. If no plan
 *      exists it logs the ad-hoc user request instead.
 *
 * Replaces @narumitw/pi-plan-mode: same goal, no menus, no plan_mode_question /
 * plan_mode_complete tools, no fresh-session handoff, no workflow mutex.
 */

import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Tools removed from the active set while in the plan role. */
const DISABLED_TOOLS = new Set(["edit", "update_plan", "ast_grep_replace", "lsp_fix"]);
/** Tool name for writing the plan. */
const PLAN_FILE = "PLAN.md";

const PLAN_INSTRUCTIONS = `PLAN role: research with read-only tools. Do not implement or change state. The only allowed write is a complete PLAN.md at the project root. Clarify material ambiguity, then write the plan, stop, and reply with a short link. Do not create todos unless requested. A blocked call is not permission to retry another mutation path.`;

const BUILD_INSTRUCTIONS = `BUILD role: implement the user's current request and any applicable accepted plan. Check existing project instructions and change memory before editing. Verify relevant behavior. At completion record only a brief change/issue note in AGENTS.md; keep history concise. Use todos when helpful or requested; do not repeat completed work.`;

type Role = "build" | "plan";
let role: Role = "build";
let savedTools: string[] | undefined;
/** True when the plan role just wrote PLAN.md in the current agent run. */
let planJustWritten = false;
/** PLAN.md mtime when the plan role was entered; detects writes from any path. */
let planMtimeAtEnter: number | undefined;

const planMtime = (cwd: string): number | undefined => {
	try {
		const target = resolve(cwd, PLAN_FILE);
		return existsSync(target) ? statSync(target).mtimeMs : undefined;
	} catch {
		return undefined;
	}
};

/** Remove single-line quoted strings (their content is never shell syntax). */
const stripQuotes = (s: string): string =>
	s.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g, " ");

/** Detect write intent in a bash command for the read-only plan role. */
function bashHasWriteIntent(command: string): string | null {
	if (!command) return null;

	// Quoted strings are data, not shell syntax: `grep 'a > b' file` and
	// `echo 'x > y'` must not trip the redirect/word scans below.
	const bare = stripQuotes(command);

	// Search patterns are data too: `grep make README.md` / `rg 'rm -rf' .` must
	// not trip the word / inline-write scans. Applies to read-only search tools
	// only; in-place editors (sed/perl -i) are re-checked on `bare` via extras.
	const searchStripped = bare.replace(
		/\b(grep|rg|ag|awk|find)\b\s*(?:-[^\s;&|]+\s+)*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s;&|]+)/gu,
		"$1",
	);

	// 1) Destructive / file-mutating / build / install command words.
	const words: string[] = [
		"rm", "rmdir", "mv", "cp", "dd", "mkdir", "touch", "ln", "chmod", "chown", "chgrp",
		"tee", "unlink", "truncate", "install", "shred", "mkfs", "mktemp", "patch",
		"git add", "git rm", "git mv", "git commit", "git push", "git tag", "git reset",
		"npm install", "npm i", "npm add", "npm remove", "npm uninstall", "npm init", "npm publish",
		"npm run", "pip install", "pip3 install", "pip uninstall", "poetry add", "yarn add",
		"pnpm add", "cargo build", "cargo add", "go mod tidy", "go build",
		"sed -i", "perl -i", "make", "docker", "kubectl", "sudo", "npx", "cargo install",
		"git clean", "git stash", "git checkout -b", "git branch -d", "git branch -D",
	];
	for (const w of words) {
		const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp("(^|[;&|\\n(\\s])" + esc + "(?=\\s|;|&|\\||$|\\))", "u");
		// Scan search-pattern-stripped text so `grep make README.md` (searching
		// for the word "make") is not a hit. In-place editors (sed -i / perl -i)
		// are re-checked below against the unstripped text via extras.
		if (re.test(searchStripped)) return "command word '" + w + "'";
	}

	// 1b) Mutating patterns the word list cannot express. Checked against the
	// unstripped text: searchStripped would eat sed/perl flags.
	const extras: Array<[RegExp, string]> = [
		[/\btar\s+-[a-zA-Z]*x|\btar\s+[^;&|]*--extract\b/u, "tar extract"],
		[/\bwget\b/u, "wget download"],
		[/\bcurl\b[^;&|]*\s(?:-o\b|--output(?:=|\s)|-[a-zA-Z]*O\b)/u, "curl download to file"],
		[/\bfind\b[^;&|]*\s-delete\b/u, "find -delete"],
		[/\bsed\s+-[^;&|\n]*\bi\b|\bperl\s+-[^;&|\n]*\bi\b/u, "in-place edit (sed/perl -i)"],
	];
	for (const [re, label] of extras) {
		if (re.test(bare)) return label;
	}

	// 2) File redirection `>` / `>>` to a real file (stderr dup and /dev/null are excluded).
	let s = bare;
	s = s.replace(/\b[012]?[<>]&[012-]?\b/g, " ");
	s = s.replace(/[0-9]?>>?\s*\/dev\/null\b/g, " ");
	const redir = /(^|[;&|(\s]|["'`])(>|>>|1>|1>>)\s*(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = redir.exec(s)) !== null) {
		return "file redirection '" + m[2] + " " + m[3] + "'";
	}

	// 3) Running a checked-out script file may write (python foo.py, sh x.sh, node x.js, ...).
	const scriptFile =
		/(^|[;&|\n\s(])(python3?|node|ruby|perl|php|sh|bash|zsh|fish|deno|bun)\s+-[^ \t]*\s+[^\s;&|]*\.(py|js|mjs|cjs|rb|pl|php|sh|bash|zsh|fish)|(^|[;&|\n\s(])(python3?|node|ruby|perl|php|sh|bash|zsh|fish|deno|bun)\s+[^\s-][^\s;&|]*\.(py|js|mjs|cjs|rb|pl|php|sh|bash|zsh|fish)(\s|$)/u;
	if (scriptFile.test(command)) return "running a script file";

	// 4) Inline interpreter code that obviously writes (heredoc / -c / -e with write calls).
	//    Interpreter code lives inside quotes, so this scan runs on the RAW
	//    command with only search-tool arguments removed — that way greping FOR
	//    write APIs (`grep -rn 'writeFileSync' src/`) is not flagged, while
	//    `python3 -c "open('x','w')"` still is.
	const inlineScan = command.replace(
		/\b(grep|rg|ag|awk|find)\b\s*(?:-[^\s;&|]+\s+)*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s;&|]+)/gu,
		"$1",
	);
	const inlineWrite =
		/(open\s*\(\s*["'][^"']*["']\s*,\s*["']w|\.write(File|FileSync)?\(|writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|renameSync|createWriteStream|os\.(remove|rmdir|unlink|rename)|shutil\.(rmtree|copy|move)|Path\([^)]*\)\.(write|mkdir|unlink|rmdir|rename))/;
	if (inlineWrite.test(inlineScan)) return "inline write call";

	return null;
}


/**
 * Choose a terminal editor. Fixed to vim, falling back to vi if vim is absent.
 */
function pickEditor(): string {
	try {
		const r = spawnSync("which", ["vim"], { encoding: "utf8" });
		if (r.status === 0 && r.stdout.trim()) return "vim";
	} catch {
		/* ignore */
	}
	return "vi";
}

/**
 * Open PLAN.md in the terminal editor (vim). Suspends the TUI so the editor
 * has full terminal access, then resumes the TUI once the user quits. Returns
 * true if the editor actually launched.
 */
async function openPlanEditor(ctx: ExtensionContext, cwd: string): Promise<boolean> {
	const target = resolve(cwd, PLAN_FILE);
	if (!existsSync(target)) {
		ctx.ui.notify(`${PLAN_FILE} not found at the project root.`, "warning");
		return false;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Opening vim requires the interactive TUI.", "warning");
		return false;
	}
	const editor = pickEditor();
	await ctx.ui.custom<null>(
		(tui, _theme, _kb, done) => {
			// Release the terminal to the external editor.
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			spawnSync(editor, [target], { stdio: "inherit", env: process.env });
			// Bring the TUI back.
			tui.start();
			tui.requestRender(true);
			done(null);
			return { render: () => [], invalidate: () => {} };
		},
	);
	return true;
}

export default function planSwitch(pi: ExtensionAPI) {
	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			"plan-switch",
			role === "plan"
				? ctx.ui.theme.fg("accent", "plan")
				: ctx.ui.theme.fg("success", "build"),
		);
	};

	function enterPlan(ctx: ExtensionContext) {
		if (role === "plan") return;
		savedTools = pi.getActiveTools();
		const allNames = new Set(pi.getAllTools().map((t) => t.name));
		// Keep `write` (constrained to PLAN.md at the tool_call boundary); drop the rest.
		pi.setActiveTools(savedTools.filter((n) => !DISABLED_TOOLS.has(n) && allNames.has(n)));
		role = "plan";
		planJustWritten = false;
		planMtimeAtEnter = planMtime(ctx.cwd);
		// Broadcast for other extensions (e.g. the sandbox gate).
		pi.events.emit("plan-switch:role", { role: "plan" });
		ctx.ui.notify("Plan role: read-only. Research, then write the plan to PLAN.md only.", "info");
		updateStatus(ctx);
	}

	function enterBuild(ctx: ExtensionContext) {
		if (role === "build") return;
		if (savedTools && savedTools.length > 0) {
			const allNames = new Set(pi.getAllTools().map((t) => t.name));
			pi.setActiveTools(savedTools.filter((n) => allNames.has(n)));
		}
		savedTools = undefined;
		role = "build";
		// Broadcast for other extensions (e.g. the sandbox gate).
		pi.events.emit("plan-switch:role", { role: "build" });
		ctx.ui.notify("Build role: full tools restored.", "info");
		updateStatus(ctx);
	}

	const toggle = (ctx: ExtensionContext) => (role === "plan" ? enterBuild(ctx) : enterPlan(ctx));

	// Option+Tab ⇄ plan / build. On macOS the terminal must map Option to Meta
	// (iTerm2: Keys -> "Left Option acts as Esc+"; Terminal.app: "Use Option as Meta key").
	pi.registerShortcut("alt+tab", {
		description: "Toggle Plan ⇄ Build role",
		handler: toggle,
	});

	// Explicit commands as a non-TUI / fallback path.
	pi.registerCommand("plan", {
		description: "Enter Plan role (read-only, writes PLAN.md)",
		handler: (_args, ctx) => {
			if (role === "plan") {
				ctx.ui.notify("Already in Plan role.", "info");
				return;
			}
			enterPlan(ctx);
		},
	});
	pi.registerCommand("build", {
		description: "Enter Build role (full tools)",
		handler: (_args, ctx) => {
			if (role === "build") {
				ctx.ui.notify("Already in Build role.", "info");
				return;
			}
			enterBuild(ctx);
		},
	});

	// Optional step after a plan is produced: open PLAN.md in vim to review/edit.
	// Available in both plan and build roles. After you quit vim (having saved),
	// control returns to the conversation; no pi restart needed.
	pi.registerCommand("plan-edit", {
		description: "Open PLAN.md in vim to review/edit it (plan + build)",
		handler: async (_args, ctx) => {
			await openPlanEditor(ctx, ctx.cwd);
		},
	});

	// Inject role instructions before each agent run. They are PREPENDED so the
	// role is the first thing the model reads — appending them to the end let
	// weaker models miss the plan-role constraints entirely.
	pi.on("before_agent_start", (event, ctx) => {
		// Re-assert the footer status every turn: pi clears ALL extension statuses
		// on /reload and session invalidation (resetExtensionUI), and session_start
		// alone does not reliably re-fire after those. Idempotent, zero cost.
		updateStatus(ctx);
		const instructions = role === "plan" ? PLAN_INSTRUCTIONS : BUILD_INSTRUCTIONS;
		return { systemPrompt: `${instructions}\n\n${event.systemPrompt}` };
	});

	// Enforce the read-only boundary while in the plan role.
	pi.on("tool_call", (event, ctx) => {
		if (role !== "plan") return;
		const name: string = (event as { toolName: string }).toolName;

		if (name === "edit" || name === "update_plan" || name === "ast_grep_replace" || name === "lsp_fix") {
			return {
				block: true,
				reason:
					"Plan role allows writing to PLAN.md only (via the write tool). No other edits are permitted.",
			};
		}

		if (name === "write") {
			const p: unknown = (event as { input?: { path?: string } }).input?.path;
			if (typeof p === "string") {
				const cwd = ctx.cwd;
				const target = resolve(cwd, p);
				const planAbs = resolve(cwd, PLAN_FILE);
				if (target === planAbs) {
					planJustWritten = true;
				} else {
					return {
						block: true,
						reason:
							`Plan role allows writing to ${PLAN_FILE} at the project root only. ` +
							`Refusing to write '${p}'. Put your plan in ${PLAN_FILE}.`,
					};
				}
			} else {
				return {
					block: true,
					reason: "Plan role write requires a path; only PLAN.md at the project root is allowed.",
				};
			}
		}

		if (name === "bash") {
			const command: unknown = (event as { input?: { command?: string } }).input?.command;
			if (typeof command === "string") {
				const why = bashHasWriteIntent(command);
				if (why) {
					return {
						block: true,
						reason:
							`Plan role allows read-only bash only (${why}). Write your plan to PLAN.md with the write tool.`,
					};
				}
			}
		}
	});

	// Auto-offer vim editing right after the plan agent writes PLAN.md and settles.
	// planJustWritten covers the write tool; the mtime check also catches PLAN.md
	// changes made through any other path. If nothing was written, tell the user
	// why no dialog appears.
	pi.on("agent_settled", async (_event, ctx) => {
		if (role !== "plan") return;
		const mtime = planMtime(ctx.cwd);
		const changed =
			planJustWritten ||
			(planMtimeAtEnter !== undefined && mtime !== planMtimeAtEnter) ||
			(planMtimeAtEnter === undefined && mtime !== undefined);
		planJustWritten = false;
		planMtimeAtEnter = mtime;
		if (!changed) {
			ctx.ui.notify(
				"Plan role: PLAN.md was not written this run — ask the agent to write the plan to PLAN.md.",
				"info",
			);
			return;
		}
		try {
			const open = await ctx.ui.confirm(
				"Open vim to edit PLAN.md?",
				"Your plan was written to PLAN.md. Open it in vim to review/edit? " +
					"(Choose No to continue; you can run /plan-edit anytime.)",
			);
			if (open) {
				await openPlanEditor(ctx, ctx.cwd);
			}
		} catch {
			// TUI dialog unavailable or interrupted; do nothing.
		}
	});

	// Every session starts in the build role; a role never leaks across sessions.
	pi.on("session_start", (_event, ctx) => {
		role = "build";
		savedTools = undefined;
		planJustWritten = false;
		pi.events.emit("plan-switch:role", { role: "build" });
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		role = "build";
		savedTools = undefined;
	});
}
