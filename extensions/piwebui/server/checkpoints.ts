/**
 * Per-turn code checkpoints, as recorded by the `checkpoint` extension.
 *
 * This module is read-only by design: the extension owns the index and the restore. Our job is to
 * show the snapshots and to hand the extension exactly the command it already accepts
 * (`/rewind <n>`), so nothing here can invent a ref or touch git itself.
 *
 * Numbering follows the extension: newest 15 entries of this repository, `#1` = newest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The extension keeps the newest entries per repo; keep the same window so `#n` means the same. */
export const CHECKPOINT_WINDOW = 15;

export interface CheckpointRow {
	/** The number shown in the list — and the number the extension's `/rewind` expects. */
	index: number;
	at: string;
	ref: string;
	shortRef: string;
	kind: "clean" | "dirty";
	files: string[];
	/** Session entry that corresponds to the turn, when the extension recorded one. */
	entryId: string | null;
}

interface IndexEntry {
	repo?: unknown;
	ref?: unknown;
	at?: unknown;
	files?: unknown;
	kind?: unknown;
	entryId?: unknown;
}

export interface CheckpointListing {
	file: string;
	repo: string | null;
	rows: CheckpointRow[];
	/** A fact about why the list is empty or incomplete — never a silent empty list. */
	note: string;
}

export function checkpointFile(agentDir: string): string {
	return join(agentDir, "checkpoints.json");
}

/**
 * Rows for one repository, newest first, numbered exactly like the extension's `/rewind list`.
 * Every failure mode is reported as a note instead of throwing or pretending there is no history.
 */
export function readCheckpoints(agentDir: string, repo: string | null): CheckpointListing {
	const file = checkpointFile(agentDir);
	if (!repo) return { file, repo: null, rows: [], note: "this workspace is not a git repository, so no checkpoints are recorded for it" };

	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { file, repo, rows: [], note: `no checkpoint index yet (${file} does not exist)` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { file, repo, rows: [], note: `the checkpoint index could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!Array.isArray(parsed)) return { file, repo, rows: [], note: `the checkpoint index has an unexpected shape (${typeof parsed})` };

	const mine = (parsed as IndexEntry[])
		.filter((entry) => entry?.repo === repo)
		.slice(-CHECKPOINT_WINDOW)
		.reverse();
	const rows: CheckpointRow[] = mine.map((entry, position) => {
		const ref = String(entry.ref ?? "");
		const files = Array.isArray(entry.files) ? entry.files.map((item) => String(item)) : [];
		return {
			index: position + 1,
			at: String(entry.at ?? ""),
			ref,
			shortRef: ref.slice(0, 12),
			kind: entry.kind === "clean" ? "clean" : "dirty",
			files,
			entryId: entry.entryId ? String(entry.entryId) : null,
		};
	});
	return {
		file,
		repo,
		rows,
		note: rows.length ? "" : `no checkpoints recorded for ${repo} yet (they are written at the end of each turn)`,
	};
}
