/**
 * Session index: pi stores sessions as JSONL files under
 * `<agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`.
 *
 * We read them directly (pi's RPC has no `list_sessions` command) but only expose the
 * facts a listing needs: header, name, first user prompt, size, timestamps. Switching is
 * done through the child's `switch_session` command; this module only resolves paths and
 * validates that a switch target really is a session file of the current cwd.
 */

import { readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface SessionSummary {
	path: string;
	id: string;
	name?: string;
	cwd?: string;
	createdAt?: string;
	updatedAt: string;
	sizeBytes: number;
	firstPrompt?: string;
	messageCount: number;
}

/** pi resolves the cwd before encoding it (`/tmp` is stored as `/private/tmp` on macOS). */
async function resolveRealPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

/** pi's directory naming for a cwd: `--` + path without the leading / with / → - + `--`. */
export async function sessionsDirFor(cwd: string, agentDir: string): Promise<string> {
	const encoded = `--${(await resolveRealPath(cwd)).replace(/^\//, "").replace(/\//g, "-")}--`;
	return join(agentDir, "sessions", encoded);
}

/** Bounded read: only the head of the file, which holds the header and early prompts. */
const HEAD_BYTES = 512 * 1024;

async function summarize(path: string): Promise<SessionSummary | null> {
	let info;
	try {
		info = await stat(path);
	} catch {
		return null;
	}
	let head = "";
	try {
		const buffer = await readFile(path);
		head = buffer.subarray(0, HEAD_BYTES).toString("utf8");
	} catch {
		return null;
	}

	const summary: SessionSummary = {
		path,
		id: basename(path).replace(/\.jsonl$/, ""),
		updatedAt: info.mtime.toISOString(),
		sizeBytes: info.size,
		messageCount: 0,
	};

	for (const line of head.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // a truncated final line is expected when the file is bigger than HEAD_BYTES
		}
		switch (entry.type) {
			case "session":
				summary.id = String(entry.id ?? summary.id);
				summary.cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
				summary.createdAt = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
				break;
			case "session_name":
			case "session_name_change":
				if (typeof entry.name === "string") summary.name = entry.name;
				break;
			case "message": {
				summary.messageCount += 1;
				const message = entry.message as { role?: string; content?: unknown } | undefined;
				if (!summary.firstPrompt && message?.role === "user") {
					const text = flatten(message.content);
					if (text) summary.firstPrompt = text.replace(/\s+/g, " ").slice(0, 140);
				}
				break;
			}
			default:
				break;
		}
	}
	return summary;
}

function flatten(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: string };
			return block?.type === "text" ? (block.text ?? "") : "";
		})
		.filter(Boolean)
		.join(" ");
}

export async function listSessions(cwd: string, agentDir: string, limit = 50): Promise<SessionSummary[]> {
	const dir = await sessionsDirFor(cwd, agentDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return []; // no sessions for this directory yet
	}
	const files = names.filter((name) => name.endsWith(".jsonl"));
	const withTimes = await Promise.all(
		files.map(async (name) => {
			const full = join(dir, name);
			try {
				const info = await stat(full);
				return { full, mtimeMs: info.mtimeMs };
			} catch {
				return null;
			}
		}),
	);
	const ordered = withTimes
		.filter((item): item is { full: string; mtimeMs: number } => item !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, limit);

	const summaries = await Promise.all(ordered.map((item) => summarize(item.full)));
	return summaries.filter((item): item is SessionSummary => item !== null);
}

/** True when `path` is a `.jsonl` session file inside the cwd's session directory. */
export async function isSessionPathOf(cwd: string, agentDir: string, path: string): Promise<boolean> {
	const dir = resolve(await sessionsDirFor(cwd, agentDir));
	const target = resolve(path);
	return target.startsWith(`${dir}/`) && target.endsWith(".jsonl");
}

/**
 * Delete a session file.
 *
 * Two invariants, both enforced here rather than at the call site: the path must be a `.jsonl`
 * session file *inside this workspace's* session directory, and it must not be the session that is
 * currently open — pi holds that file and would keep writing into a deleted inode. Callers are
 * expected to have asked the user; this function never guesses.
 */
export async function deleteSession(
	cwd: string,
	agentDir: string,
	path: string,
	options: { current?: string | null } = {},
): Promise<void> {
	if (!(await isSessionPathOf(cwd, agentDir, path))) {
		throw new Error(`refused: not a session file of ${cwd}: ${path}`);
	}
	const current = options.current ? resolve(options.current) : null;
	if (current && resolve(path) === current) {
		throw new Error("refused: this session is open — switch to another one before deleting it");
	}
	await unlink(path);
}
