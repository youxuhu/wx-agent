/**
 * Filesystem side of the panel: the folder picker, the project tree (read-only) and file reads.
 *
 * Invariants: every path is resolved with realpath and must stay inside the workspace (or one
 * of the two browsable roots for the folder picker); `.git` is not descended into; huge files
 * and binaries are refused with a fact instead of being streamed.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export interface DirEntry {
	name: string;
	path: string;
	type: "dir" | "file" | "symlink" | "other";
	size: number;
	mtimeMs: number;
	ignored?: boolean;
}

export interface BrowseRoot {
	path: string;
	label: string;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

async function realpathOrNull(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
}

function inside(root: string, target: string): boolean {
	return target === root || target.startsWith(root + sep);
}

/** Places the folder picker may browse: the home directory and /tmp (macOS realpath: /private/tmp). */
export async function browseRoots(): Promise<BrowseRoot[]> {
	const roots: BrowseRoot[] = [];
	const home = await realpathOrNull(homedir());
	if (home) roots.push({ path: home, label: "home" });
	const tmp = await realpathOrNull("/tmp");
	if (tmp) roots.push({ path: tmp, label: "tmp" });
	return roots;
}

export interface BrowseOptions {
	path?: string;
	/** Override the browse roots (tests use a fixture directory). */
	roots?: string[];
}

export async function browse(requested: string | null, options: BrowseOptions = {}): Promise<{ path: string; parent: string | null; roots: BrowseRoot[]; entries: DirEntry[] } | string> {
	const roots = options.roots
		? await Promise.all(options.roots.map(async (path) => ({ path: (await realpathOrNull(path)) ?? path, label: path })))
		: await browseRoots();
	const home = roots[0]?.path ?? null;
	const target = requested && requested.trim() ? requested : home;
	if (!target) return "refused: no home directory to browse";
	const resolved = await realpathOrNull(target);
	if (!resolved) return `refused: ${target} does not exist`;
	if (!roots.some((root) => inside(root.path, resolved))) {
		// The two roots are deliberately narrow: the picker is not a general filesystem browser.
		return `refused: ${resolved} is outside the browsable roots (${roots.map((root) => root.path).join(", ")})`;
	}
	const entries = await listDir("/", resolved, { showIgnored: false, dirsOnly: true });
	const parentReal = await realpathOrNull(join(resolved, ".."));
	return {
		path: resolved,
		parent: parentReal && roots.some((root) => inside(root.path, parentReal)) ? parentReal : null,
		roots,
		entries,
	};
}

/** List one directory level. `root` is the containment root (a workspace or "/" for browsing). */
export async function listDir(root: string, dir: string, options: { showIgnored?: boolean; dirsOnly?: boolean } = {}): Promise<DirEntry[]> {
	const rootReal = (await realpathOrNull(root)) ?? root;
	const dirReal = (await realpathOrNull(dir)) ?? dir;
	if (rootReal !== "/" && !inside(rootReal, dirReal)) throw new Error(`refused: ${dirReal} is outside ${rootReal}`);
	const dirents = await readdir(dirReal, { withFileTypes: true });
	const entries: DirEntry[] = [];
	for (const dirent of dirents) {
		if (dirent.name === ".git") continue; // never descend into the object store
		const path = join(dirReal, dirent.name);
		const type = dirent.isDirectory() ? "dir" : dirent.isSymbolicLink() ? "symlink" : dirent.isFile() ? "file" : "other";
		if (options.dirsOnly && type !== "dir" && type !== "symlink") continue;
		let info: { size: number; mtimeMs: number } = { size: 0, mtimeMs: 0 };
		try {
			const stats = await stat(path);
			info = { size: stats.size, mtimeMs: stats.mtimeMs };
		} catch {
			/* broken symlink: report it without stats */
		}
		entries.push({ name: dirent.name, path, type, ...info });
	}
	entries.sort((a, b) => {
		const aDir = a.type === "dir" ? 0 : 1;
		const bDir = b.type === "dir" ? 0 : 1;
		if (aDir !== bDir) return aDir - bDir;
		return a.name.localeCompare(b.name);
	});
	if (!options.showIgnored) {
		const ignored = await ignoredSet(dirReal, entries.map((entry) => entry.name));
		for (const entry of entries) if (ignored.has(entry.name)) entry.ignored = true;
	}
	return entries;
}

/** Batch `.gitignore` check via git itself; outside a repo nothing is ignored. */
async function ignoredSet(dir: string, names: string[]): Promise<Set<string>> {
	if (!names.length) return new Set();
	return new Promise<Set<string>>((done) => {
		const child = execFile("git", ["check-ignore", "-z", "--stdin"], { cwd: dir, encoding: "utf8", timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
			if (error && !stdout) {
				done(new Set());
				return;
			}
			done(new Set(stdout.split("\0").filter(Boolean)));
		});
		child.stdin?.end(names.join("\0"));
	});
}

export interface FileRead {
	path: string;
	bytes: number;
	text: string;
	language: string | null;
	binary: boolean;
	truncated: boolean;
}

export async function readText(root: string, requested: string): Promise<FileRead | string> {
	const rootReal = await realpathOrNull(root);
	if (!rootReal) return `refused: workspace ${root} does not exist`;
	const target = isAbsolute(requested) ? requested : join(rootReal, requested);
	const targetReal = await realpathOrNull(target);
	if (!targetReal) return `refused: ${requested} does not exist`;
	// Realpath containment: a symlink pointing outside the workspace is refused too.
	if (!inside(rootReal, targetReal)) return `refused: ${targetReal} is outside the workspace ${rootReal}`;
	const info = await stat(targetReal);
	if (!info.isFile()) return `refused: ${targetReal} is not a regular file`;
	if (info.size > MAX_TEXT_BYTES) return `refused: ${targetReal} is ${info.size} bytes (limit ${MAX_TEXT_BYTES})`;
	const buffer = await readFile(targetReal);
	const binary = buffer.includes(0);
	if (binary) return `refused: ${targetReal} looks binary (${info.size} bytes) — no binary preview`;
	return { path: targetReal, bytes: info.size, text: buffer.toString("utf8"), language: languageOf(targetReal), binary: false, truncated: false };
}

export function languageOf(path: string): string | null {
	const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".mjs": "javascript",
		".cjs": "javascript",
		".vue": "vue",
		".json": "json",
		".md": "markdown",
		".css": "css",
		".html": "html",
		".sh": "shell",
		".py": "python",
		".rs": "rust",
		".go": "go",
		".yml": "yaml",
		".yaml": "yaml",
		".toml": "toml",
	};
	return map[ext] ?? null;
}

export function relativeTo(root: string, path: string): string {
	const rel = relative(root, path);
	return rel === "" ? "." : rel;
}
