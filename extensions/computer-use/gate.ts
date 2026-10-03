/**
 * gate.ts — GateAgent observation pipeline (PLAN §5).
 *
 * Phase 1 scope (per task assignment):
 *   - stateHash(): deterministic dHash 8x8 grayscale over RGBA raster data (16 hex chars)
 *   - blocked detection (§5.5): no-progress / focus-change / popup, from window lists + hashes
 *   - widgetTree merge (§5.4) is a TODO stub — lands with the a11y backends in Phase 2.
 */

import type { BlockInfo, WindowInfo } from "./platform";

export interface WidgetNode {
	index: number; // depth-first, 1-based, tree-wide
	role: string;
	label: string; // visible text/title, truncated to 80 chars
	value?: string;
	center: { x: number; y: number }; // screenshot raster coordinate space
	clickable: boolean;
	children: WidgetNode[];
}

/**
 * dHash 8x8 (PLAN §2): box-average the RGBA raster down to a 9x8 grayscale grid,
 * output 64 comparison bits (left vs right neighbor per row) as 16 hex chars.
 * Runs in O(pixels); safe for full Retina rasters.
 */
export function stateHash(rgba: Buffer, width: number, height: number): string {
	if (!width || !height || rgba.length < width * height * 4) {
		return "0000000000000000";
	}
	const GW = 9;
	const GH = 8;
	const grid = new Float64Array(GW * GH);
	const counts = new Float64Array(GW * GH);
	for (let y = 0; y < height; y++) {
		const gy = Math.min(GH - 1, Math.floor((y * GH) / height));
		const row = y * width * 4;
		for (let x = 0; x < width; x++) {
			const gx = Math.min(GW - 1, Math.floor((x * GW) / width));
			const o = row + x * 4;
			// Rec.601 luma
			grid[gy * GW + gx] += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
			counts[gy * GW + gx] += 1;
		}
	}
	const gray = new Array<number>(GW * GH);
	for (let i = 0; i < grid.length; i++) gray[i] = counts[i] > 0 ? grid[i] / counts[i] : 0;
	let bits = "";
	for (let gy = 0; gy < GH; gy++) {
		for (let gx = 0; gx < GW - 1; gx++) {
			bits += gray[gy * GW + gx] < gray[gy * GW + gx + 1] ? "1" : "0";
		}
	}
	let hex = "";
	for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
	return hex;
}

/** Maps widget-tree index -> raster-space center, for `element` targeting (PLAN §3.1). */
export function buildWidgetIndex(root: WidgetNode | null | undefined): Map<number, { x: number; y: number }> {
	const map = new Map<number, { x: number; y: number }>();
	if (!root) return map;
	const walk = (n: WidgetNode) => {
		map.set(n.index, { x: n.center.x, y: n.center.y });
		n.children.forEach(walk);
	};
	walk(root);
	return map;
}

/**
 * TODO(Phase 2): mergeTree() — merge the backend AxxNode JSON (Swift AX / pyatspi / UIA)
 * into a WidgetNode tree per PLAN §5.4 (depth-first indices, bounds->center conversion into
 * the screenshot raster space, clickable role set, 80-char label truncation, staticText pruning
 * down to <=400 nodes, window-bounds realignment). Stub returns null until a11y lands.
 */
export function mergeTree(): WidgetNode | null {
	return null;
}

export interface BlockInfo {
	kind: "popup" | "focus-change" | "no-progress";
	detail: string; // human- and model-readable
	hint: string; // suggested next move
}

export interface Observation {
	screenshot?: {
		base64: string;
		width: number;
		height: number; // raster actual size (authoritative coordinate reference)
	};
	widgetTree?: WidgetNode; // Phase 2 onwards
	windows: WindowInfo[];
	blocked: BlockInfo | null;
	stateHash: string; // 16-hex dHash 8x8 grayscale of the screenshot
}

/** Detects blocked conditions per PLAN §5.5 (deterministic, no model involvement). */
export function detectBlocked(input: {
	mutating: boolean;
	hash: string;
	prevHash: string | null;
	windows: WindowInfo[];
	prevWindows: WindowInfo[];
	knownWindows: Set<string> | null;
}): BlockInfo | null {
	const { mutating, hash, prevHash, windows, prevWindows, knownWindows } = input;
	const focused = windows.find((w) => w.isFocused);
	const prevFocused = prevWindows.find((w) => w.isFocused);

	// no-progress: same perceptual hash as the immediately previous observation (N=1).
	if (mutating && prevHash !== null && hash === prevHash && hash !== "") {
		return { kind: "no-progress", detail: "screen unchanged after the action", hint: "try a different path or check whether the action took effect" };
	}
	// focus-change: focused window changed and it is not where we were working.
	if (mutating && focused && prevFocused && focused.appName !== prevFocused.appName) {
		return { kind: "focus-change", detail: `focus moved from ${prevFocused.appName} to ${focused.appName}`, hint: "a dialog or new window stole focus; deal with it first (e.g. press Esc)" };
	}
	// popup: focused window was not in the previously listed set of windows.
	if (mutating && focused && knownWindows && !knownWindows.has(windowKey(focused))) {
		return { kind: "popup", detail: `focused window '${focused.title || focused.appName}' is new`, hint: "handle the popup before continuing" };
	}
	return null;
}

export function windowKey(w: WindowInfo): string {
	return `${w.appName}::${w.title}`;
}
