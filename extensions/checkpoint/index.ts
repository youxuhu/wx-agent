/**
 * checkpoint — per-turn git snapshots and `/rewind` (code + conversation).
 *
 * Before each turn the extension records a snapshot with `git stash create`
 * (a commit object; the worktree is left untouched). `/rewind` lists the
 * snapshots and restores the code to one of them — always snapshotting the
 * current state first, so a rewind can itself be rewound. With `--tree` it also
 * navigates the conversation back to the matching turn.
 *
 * Index: ~/.pi/agent/checkpoints.json — [{ repo, ref, at, entryId, files }], capped.
 * Commands: /rewind [n] [--tree] | /rewind list
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Checkpoint {
	repo: string;
	ref: string;
	at: string;
	entryId?: string;
	files: string[];
	/** "clean" = tree had no uncommitted changes, ref points at HEAD */
	kind?: "clean" | "dirty";
}

/**
 * The agent directory honours PI_CODING_AGENT_DIR so a probe or a test instance can point at its
 * own directory instead of writing into the real one.
 */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const INDEX_PATH = join(AGENT_DIR, "checkpoints.json");
const MAX_ENTRIES = 50;

function loadIndex(): Checkpoint[] {
	if (!existsSync(INDEX_PATH)) return [];
	try {
		const raw = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
		return Array.isArray(raw) ? (raw as Checkpoint[]) : [];
	} catch {
		return [];
	}
}

function saveIndex(entries: Checkpoint[]): void {
	writeFileSync(INDEX_PATH, `${JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2)}\n`, "utf8");
}

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr?: string; exitCode?: number }>;

export default function (pi: ExtensionAPI) {
	const exec: Exec = async (cmd, args) => {
		const r = await pi.exec(cmd, args).catch((e: unknown) => ({ stdout: "", stderr: String(e), exitCode: 1 }));
		return r as { stdout: string; stderr?: string; exitCode?: number };
	};

	let currentEntryId: string | undefined;
	/** repo path → newest in-memory ref (mirrored into the on-disk index) */
	const sessionRefs = new Map<string, string[]>();

	const repoOf = async (cwd: string): Promise<string | null> => {
		const r = await exec("git", ["rev-parse", "--show-toplevel"]);
		const top = r.stdout.trim();
		return top ? top : null;
	};

	const snapshot = async (repo: string, cwd: string, entryId?: string): Promise<string | null> => {
		const created = await exec("git", ["stash", "create"]);
		const stashRef = created.stdout.trim();
		const changed = await exec("git", ["status", "--porcelain"]);
		const files = changed.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 30);
		let ref = stashRef;
		let kind: Checkpoint["kind"] = "dirty";
		if (!ref) {
			// clean tree: the restore point is HEAD, so the turn can still be rewound to
			const head = await exec("git", ["rev-parse", "HEAD"]);
			ref = head.stdout.trim();
			kind = "clean";
			if (!ref) return null; // no commits (or not a repo): nothing to reference
		}
		const entry: Checkpoint = { repo, ref, at: new Date().toISOString(), entryId, files: kind === "clean" ? [] : files, kind };
		const index = loadIndex();
		// identical consecutive snapshot (no change since the last turn) — keep the index meaningful
		const last = [...index].reverse().find((c) => c.repo === repo);
		if (last && last.ref === ref) return ref;
		index.push(entry);
		saveIndex(index);
		const list = sessionRefs.get(repo) ?? [];
		list.push(ref);
		sessionRefs.set(repo, list);
		return ref;
	};

	pi.on("turn_start", async (_event, ctx) => {
		const repo = await repoOf(ctx.cwd);
		if (!repo) return; // silently a no-op outside git repos
		await snapshot(repo, ctx.cwd, currentEntryId);
	});

	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const repo = await repoOf(ctx.cwd);
		if (!repo) return;
		const match = loadIndex().filter((c) => c.repo === repo && c.entryId === event.entryId);
		const ref = match[match.length - 1]?.ref;
		if (!ref || !ctx.hasUI) return;
		const choice = await ctx.ui.select("Restore code state?", ["Yes, restore code to that point", "No, keep current code"]);
		if (choice?.startsWith("Yes")) {
			await restore(repo, ref, ctx.cwd, (m) => ctx.ui.notify(m, "info"));
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	/** Restore `ref`, snapshotting the current state first so the rewind is reversible. */
	async function restore(repo: string, ref: string, cwd: string, notify: (m: string) => void): Promise<void> {
		const safety = await snapshot(repo, cwd);
		if (safety) notify(`current state saved as ${safety.slice(0, 12)} (rewind is reversible)`);
		const r = await exec("git", ["checkout", ref, "--", "."]);
		if (r.exitCode && r.exitCode !== 0) throw new Error(r.stderr?.trim() || `git checkout ${ref} failed`);
		// files added after the snapshot stay in place; report that as a fact
		const leftover = await exec("git", ["diff", "--name-only", ref]);
		const remaining = leftover.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		if (remaining.length) {
			notify(`${remaining.length} file(s) still differ from the snapshot (added/changed later, not deleted): ${remaining.slice(0, 5).join(", ")}`);
		}
	}

	pi.registerCommand("rewind", {
		description: "Restore code to a per-turn checkpoint: /rewind [n] [--tree] | /rewind list",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const withTree = tokens.includes("--tree");
			const numeric = tokens.find((t) => /^\d+$/.test(t));
			const repo = await repoOf(ctx.cwd);
			if (!repo) {
				ctx.ui.notify("checkpoint: not a git repository", "warning");
				return;
			}
			const mine = loadIndex().filter((c) => c.repo === repo).slice(-15).reverse();
			if (mine.length === 0) {
				ctx.ui.notify("checkpoint: no snapshots recorded yet", "info");
				return;
			}
			if (tokens[0] === "list") {
				ctx.ui.notify(
					mine
						.map(
							(c, i) =>
								`#${i + 1} ${c.at.slice(11, 19)} ${c.ref.slice(0, 12)} ${c.kind === "clean" ? "clean tree" : `${c.files.length} file(s): ${c.files.slice(0, 3).join(", ")}`}`,
						)
						.join("\n"),
					"info",
				);
				return;
			}

			let target: Checkpoint | undefined;
			if (numeric) {
				const idx = Number(numeric);
				target = mine[idx - 1];
				if (!target) {
					ctx.ui.notify(`checkpoint: no snapshot #${idx} (1..${mine.length})`, "warning");
					return;
				}
			} else {
				const labels = mine.map(
					(c, i) =>
						`#${i + 1} ${c.at.slice(11, 19)} ${c.kind === "clean" ? "clean" : `${c.files.length}f`} ${c.files.slice(0, 2).join(",")}`,
				);
				const picked = await ctx.ui.select("Rewind code to which snapshot?", labels);
				if (!picked) return;
				target = mine[Number(picked.match(/^#(\d+)/)?.[1] ?? "0") - 1];
				if (!target) return;
			}

			const ok = await ctx.ui.confirm(
				"Rewind code state?",
				`restore ${target.files.length} tracked file(s) to ${target.at}\ncurrent state is snapshotted first`,
			);
			if (!ok) {
				ctx.ui.notify("checkpoint: rewind cancelled", "info");
				return;
			}
			try {
				await restore(repo, target.ref, ctx.cwd, (m) => ctx.ui.notify(m, "info"));
			} catch (e) {
				ctx.ui.notify(`checkpoint: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}
			ctx.ui.notify(`code rewound to ${target.at} (${target.ref.slice(0, 12)})`, "info");

			if (withTree && target.entryId) {
				try {
					await ctx.navigateTree(target.entryId, {});
					ctx.ui.notify("conversation navigated to the matching turn", "info");
				} catch (e) {
					ctx.ui.notify(`checkpoint: tree navigation failed — ${e instanceof Error ? e.message : String(e)}`, "warning");
				}
			}
		},
	});
}
