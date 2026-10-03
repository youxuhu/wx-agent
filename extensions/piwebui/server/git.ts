/**
 * Git access for the panel: a thin, opinionated wrapper around the `git` CLI.
 *
 * Invariants enforced here:
 *  - the browser never supplies argv. Every action composes its own arguments, so there is
 *    no code path for force-push, merge, `reset --hard`, `clean -fd` or interactive rebase.
 *  - reads never take the index lock and never prompt for credentials.
 *  - destructive actions take a snapshot ref first and report it as a fact.
 *  - writes are serialized per repository.
 *  - every failure is returned verbatim; nothing is retried or reported as success.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export interface GitResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	argv: string[];
	timedOut: boolean;
}

export interface GitEntry {
	path: string;
	/** index status letter (`.` = unchanged) */
	index: string;
	/** worktree status letter (`.` = unchanged) */
	worktree: string;
	kind: "changed" | "renamed" | "unmerged" | "untracked" | "ignored";
	origPath?: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	conflicted: boolean;
}

export interface GitStatus {
	repo: boolean;
	root: string | null;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	entries: GitEntry[];
	error?: string;
}

export interface GitBranch {
	name: string;
	sha: string;
	date: string;
	upstream: string;
	remote: boolean;
}

export interface GitCommit {
	hash: string;
	short: string;
	author: string;
	date: string;
	subject: string;
	refs: string;
}

const BASE_ARGS = ["-c", "core.quotepath=false", "-c", "color.ui=false", "--no-pager"];
const CHILD_ENV = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0", // never block on credentials
	GIT_OPTIONAL_LOCKS: "0", // reads must not write the index
	GIT_PAGER: "cat",
	LC_ALL: "C",
};

/** Per-repository write queue: one git write at a time, in order. */
const writeQueues = new Map<string, Promise<unknown>>();

function queued<T>(root: string, task: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(root) ?? Promise.resolve();
	const next = previous.then(task, task);
	writeQueues.set(
		root,
		next.catch(() => undefined),
	);
	return next;
}

async function run(root: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
	return new Promise<GitResult>((done) => {
		const argv = [...BASE_ARGS, ...args];
		const child = execFile(
			"git",
			argv,
			{ cwd: root, env: CHILD_ENV, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
				done({
					ok: !error,
					code: error ? ((error as { code?: number }).code ?? null) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? (error ? String((error as Error).message) : ""),
					argv: ["git", ...argv],
					timedOut,
				});
			},
		);
		void child;
	});
}

/** Refuse anything that is not inside the workspace before it reaches git. */
export async function safePaths(root: string, paths: string[]): Promise<string[] | string> {
	const rootReal = await realpath(root);
	const out: string[] = [];
	for (const path of paths) {
		const target = isAbsolute(path) ? path : `${rootReal}/${path}`;
		const rel = relative(rootReal, target);
		if (rel.startsWith("..") || isAbsolute(rel)) return `refused: ${path} is outside ${rootReal}`;
		out.push(rel === "" ? "." : rel);
	}
	return out;
}

export async function isRepo(root: string): Promise<boolean> {
	const result = await run(root, ["rev-parse", "--is-inside-work-tree"], 5_000);
	return result.ok && result.stdout.trim() === "true";
}

export async function repoRoot(root: string): Promise<string | null> {
	const result = await run(root, ["rev-parse", "--show-toplevel"], 5_000);
	return result.ok ? result.stdout.trim() || null : null;
}

function parseStatus(stdout: string): Omit<GitStatus, "repo" | "root"> {
	const tokens = stdout.split("\0").filter((token) => token.length > 0);
	let branch: string | null = null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	const entries: GitEntry[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith("# branch.head ")) {
			branch = token.slice("# branch.head ".length);
			continue;
		}
		if (token.startsWith("# branch.upstream ")) {
			upstream = token.slice("# branch.upstream ".length);
			continue;
		}
		if (token.startsWith("# branch.ab ")) {
			const match = token.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}
		if (token.startsWith("#")) continue;
		const kindChar = token[0];
		if (kindChar === "?" || kindChar === "!") {
			const path = token.slice(2);
			entries.push({
				path,
				index: kindChar,
				worktree: kindChar,
				kind: kindChar === "?" ? "untracked" : "ignored",
				staged: false,
				unstaged: false,
				untracked: kindChar === "?",
				conflicted: false,
			});
			continue;
		}
		if (kindChar === "1" || kindChar === "2" || kindChar === "u") {
			const fields = token.split(" ");
			const xy = fields[1] ?? "..";
			const path = fields.slice(kindChar === "1" ? 8 : kindChar === "2" ? 9 : 10).join(" ");
			let origPath: string | undefined;
			if (kindChar === "2") {
				origPath = tokens[++i];
			}
			const index = xy[0] ?? ".";
			const worktree = xy[1] ?? ".";
			entries.push({
				path,
				index,
				worktree,
				kind: kindChar === "u" ? "unmerged" : kindChar === "2" ? "renamed" : "changed",
				origPath,
				staged: index !== "." && index !== "?",
				unstaged: worktree !== "." && worktree !== "?",
				untracked: false,
				conflicted: kindChar === "u",
			});
		}
	}
	return { branch, upstream, ahead, behind, entries };
}

export async function status(root: string): Promise<GitStatus> {
	if (!(await isRepo(root))) {
		return { repo: false, root: null, branch: null, upstream: null, ahead: 0, behind: 0, entries: [] };
	}
	const top = await repoRoot(root);
	const result = await run(root, ["status", "--porcelain=v2", "-z", "-b", "--untracked-files=all"]);
	if (!result.ok) {
		return { repo: true, root: top, branch: null, upstream: null, ahead: 0, behind: 0, entries: [], error: result.stderr.trim() || `git exited ${result.code}` };
	}
	return { repo: true, root: top, ...parseStatus(result.stdout) };
}

export async function diff(root: string, options: { path?: string; staged?: boolean; ref?: string; context?: number }): Promise<GitResult> {
	const args = ["diff", `--unified=${options.context ?? 3}`, "--no-color", "--no-ext-diff"];
	if (options.staged) args.push("--cached");
	if (options.ref) args.push(options.ref);
	if (options.path) {
		const safe = await safePaths(root, [options.path]);
		if (typeof safe === "string") return { ok: false, code: null, stdout: "", stderr: safe, argv: [], timedOut: false };
		args.push("--", ...safe);
	}
	return run(root, args);
}

export async function numstat(root: string, staged: boolean): Promise<Record<string, { added: number; deleted: number }>> {
	const args = ["diff", "--numstat", "--no-color"];
	if (staged) args.push("--cached");
	const result = await run(root, args);
	const out: Record<string, { added: number; deleted: number }> = {};
	for (const line of result.stdout.split("\n")) {
		const [added, deleted, ...rest] = line.split("\t");
		if (!rest.length) continue;
		out[rest.join("\t")] = { added: added === "-" ? 0 : Number(added), deleted: deleted === "-" ? 0 : Number(deleted) };
	}
	return out;
}

export async function show(root: string, ref: string, patch = true): Promise<GitResult> {
	// `ref` must look like an object name; never a flag or a revision expression.
	if (!/^[0-9a-f]{4,40}$/i.test(ref) && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
		return { ok: false, code: null, stdout: "", stderr: `refused: ${ref} is not a commit-ish`, argv: [], timedOut: false };
	}
	const args = ["show", "--no-color", "--date=iso-strict", "--stat", "--pretty=fuller"];
	if (!patch) args.push("--no-patch");
	args.push(ref);
	return run(root, args);
}

export async function branches(root: string): Promise<GitBranch[]> {
	// NOTE: for-each-ref does not expand %x1f (git log does), so use a literal tab. Refnames
	// cannot contain control characters, which keeps the split unambiguous.
	const sep = "\t";
	const result = await run(root, [
		"for-each-ref",
		"refs/heads",
		"refs/remotes",
		`--format=%(refname:short)${sep}%(objectname:short)${sep}%(committerdate:iso-strict)${sep}%(upstream:short)${sep}%(refname)`,
	]);
	if (!result.ok) return [];
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [name, sha, date, upstream, full = ""] = line.split(sep);
			return { name, sha, date, upstream, remote: full.startsWith("refs/remotes/") };
		})
		.filter((branch) => branch.name && !branch.name.endsWith("/HEAD"));
}

export async function log(root: string, options: { limit?: number; ref?: string; path?: string } = {}): Promise<GitCommit[]> {
	const args = ["log", `-n ${Math.min(Math.max(options.limit ?? 100, 1), 500)}`, "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%d"];
	if (options.ref && /^[A-Za-z0-9._/-]+$/.test(options.ref)) args.push(options.ref);
	if (options.path) {
		const safe = await safePaths(root, [options.path]);
		if (typeof safe === "string") return [];
		args.push("--", ...safe);
	}
	const result = await run(root, args);
	if (!result.ok) return [];
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, short, author, date, subject, refs] = line.split("\x1f");
			return { hash, short, author, date, subject, refs: (refs ?? "").trim() };
		});
}

export async function stashList(root: string): Promise<Array<{ index: number; ref: string; subject: string }>> {
	const result = await run(root, ["stash", "list", "--pretty=format:%gd%x1f%s"]);
	if (!result.ok) return [];
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line, index) => {
			const [ref, subject] = line.split("\x1f");
			return { index, ref, subject };
		});
}

/** Snapshot the working tree into a ref, so a destructive action stays reversible. */
async function snapshot(root: string, reason: string): Promise<{ ref: string | null; detail: string }> {
	const stash = await run(root, ["stash", "create", reason]);
	const sha = stash.stdout.trim();
	if (!stash.ok || !sha) {
		return { ref: null, detail: `no snapshot taken: git stash create reported "${(stash.stderr || "empty (working tree matches HEAD)").trim()}"` };
	}
	const ref = `refs/piwebui/${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const created = await run(root, ["update-ref", ref, sha]);
	return created.ok ? { ref, detail: `snapshot at ${ref}` } : { ref: null, detail: `snapshot failed: ${created.stderr.trim()}` };
}

export interface ActionOutcome {
	ok: boolean;
	verbatim: string;
	argv: string[];
	snapshot?: { ref: string | null; detail: string };
}

const outcome = (result: GitResult, extra: Partial<ActionOutcome> = {}): ActionOutcome => ({
	ok: result.ok,
	verbatim: (result.ok ? result.stdout : result.stderr || result.stdout).trim() || `git exited ${result.code}`,
	argv: result.argv,
	...extra,
});

export async function stage(root: string, paths: string[]): Promise<ActionOutcome> {
	const safe = await safePaths(root, paths);
	if (typeof safe === "string") return { ok: false, verbatim: safe, argv: [] };
	return queued(root, async () => outcome(await run(root, ["add", "--", ...safe])));
}

export async function unstage(root: string, paths: string[]): Promise<ActionOutcome> {
	const safe = await safePaths(root, paths);
	if (typeof safe === "string") return { ok: false, verbatim: safe, argv: [] };
	// `restore --staged` only exists on git >= 2.23; the checked-in git is 2.55.
	return queued(root, async () => outcome(await run(root, ["restore", "--staged", "--", ...safe])));
}

/**
 * Discard worktree+index changes for tracked paths. Untracked files are refused outright:
 * deleting them is `git clean`, which this code intentionally cannot do.
 */
export async function discard(root: string, paths: string[], confirmed: boolean): Promise<ActionOutcome> {
	const safe = await safePaths(root, paths);
	if (typeof safe === "string") return { ok: false, verbatim: safe, argv: [] };
	if (!confirmed) {
		return { ok: false, verbatim: "refused: discard rewrites the working tree and needs confirmed:true", argv: [] };
	}
	const current = await status(root);
	const untracked = safe.filter((path) => current.entries.some((entry) => entry.path === path && entry.untracked));
	if (untracked.length) {
		return { ok: false, verbatim: `refused: ${untracked.join(", ")} is untracked — deleting untracked files is not implemented`, argv: [] };
	}
	return queued(root, async () => {
		const snap = await snapshot(root, "piwebui discard snapshot");
		const result = await run(root, ["restore", "--worktree", "--staged", "--", ...safe]);
		return outcome(result, { snapshot: snap });
	});
}

export async function commit(root: string, message: string, amend: boolean): Promise<ActionOutcome> {
	if (!message.trim()) return { ok: false, verbatim: "refused: empty commit message", argv: [] };
	if (amend) {
		return queued(root, async () => {
			const snap = await snapshot(root, "piwebui pre-amend snapshot");
			return outcome(await run(root, ["commit", "--amend", "-m", message]), { snapshot: snap });
		});
	}
	return queued(root, async () => outcome(await run(root, ["commit", "-m", message])));
}

export async function checkout(root: string, branch: string): Promise<ActionOutcome> {
	const known = (await branches(root)).find((item) => item.name === branch);
	if (!known) return { ok: false, verbatim: `refused: ${branch} is not a local or remote branch of this repository`, argv: [] };
	if (known.remote) return { ok: false, verbatim: `refused: ${branch} is a remote branch; create a local branch instead`, argv: [] };
	const current = await status(root);
	const dirty = current.entries.filter((entry) => !entry.untracked);
	if (dirty.length) {
		return {
			ok: false,
			verbatim: `refused: ${dirty.length} path(s) have uncommitted changes (${dirty.slice(0, 5).map((entry) => entry.path).join(", ")}) — commit or stash them first`,
			argv: [],
		};
	}
	return queued(root, async () => outcome(await run(root, ["checkout", branch])));
}

export async function createBranch(root: string, name: string): Promise<ActionOutcome> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..") || name.endsWith("/")) {
		return { ok: false, verbatim: `refused: ${name} is not a valid branch name`, argv: [] };
	}
	return queued(root, async () => outcome(await run(root, ["checkout", "-b", name])));
}
