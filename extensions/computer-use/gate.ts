/**
 * gate.ts — GateAgent observation pipeline (PLAN §5).
 *
 * Phase 1 scope (per task assignment):
 *   - stateHash(): deterministic dHash 8x8 grayscale over RGBA raster data (16 hex chars)
 *   - blocked detection (§5.5): no-progress / focus-change / popup, from window lists + hashes
 *   - widgetTree merge (§5.4) is a TODO stub — lands with the a11y backends in Phase 2.
 */

import type { BlockInfo, WindowInfo } from "./platform";

export type ObservationLevel = "full" | "tree" | "minimal"; // PLAN §1.1

export interface WidgetNode {
	index: number; // depth-first, 1-based, tree-wide
	role: string;
	label: string; // visible text/title, truncated to 80 chars
	value?: string;
	center: { x: number; y: number }; // LOGICAL screen coordinates (v3.1 §3)
	clickable: boolean;
	focused: boolean;
	children: WidgetNode[];
}

/** Raw AX node JSON emitted by the darwin Swift snippet (darwin.ts AX_SWIFT). */
export interface RawAxNode {
	role: string;
	title: string;
	value: string;
	focused: boolean;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	children?: RawAxNode[];
}

/** AX roles considered actionable (PLAN v2 §5.4 clickable whitelist). */
const CLICKABLE_ROLES: ReadonlySet<string> = new Set([
	"AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
	"AXPopUpButton", "AXTabGroup", "AXTab", "AXSlider", "AXTextArea", "AXTextField",
	"AXComboBox", "AXSearchField", "AXDisclosureTriangle", "AXIncrementor",
]);

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
 * mergeRawAx (PLAN §3 + v2 §5.4): convert the Swift AX dump into the WidgetNode tree.
 * Depth-first 1-based indices, clickable whitelist, 80-char label truncation, pruning down
 * to <=400 nodes. Coordinates stay in the LOGICAL screen space (§3 coordSpace="logical").
 */
export function mergeRawAx(raw: RawAxNode, maxNodes = 400): WidgetNode | null {
	let index = 0;
	const walk = (n: RawAxNode, depth: number): WidgetNode | null => {
		if (depth > 12 || index >= maxNodes) return null;
		const hasGeom = typeof n.x === "number" && typeof n.y === "number";
		const clickable = CLICKABLE_ROLES.has(n.role);
		const label = (n.title || n.value || "").slice(0, 80);
		const kids = n.children ?? [];
		// Prune unlabeled, geometry-less, non-clickable leaves and single-child passthrough wrappers.
		if (!clickable && !hasGeom && kids.length === 0) return null;
		if (!clickable && !hasGeom && !label && kids.length === 1) return walk(kids[0], depth);
		index += 1;
		const node: WidgetNode = {
			index,
			role: n.role.replace(/^AX/, "") || "unknown",
			label,
			value: n.value && n.value !== label ? n.value.slice(0, 80) : undefined,
			center: {
				x: Math.round((n.x ?? 0) + (n.w ?? 0) / 2),
				y: Math.round((n.y ?? 0) + (n.h ?? 0) / 2),
			},
			clickable,
			focused: Boolean(n.focused),
			children: [],
		};
		for (const c of kids) {
			if (index >= maxNodes) break;
			const child = walk(c, depth + 1);
			if (child) node.children.push(child);
		}
		return node;
	};
	return walk(raw, 0);
}

/**
 * treeFingerprint (PLAN §1.3): node count + first 16 (role,label,bounds) triples hashed
 * (djb2) to 16 hex chars. Compare via treeChangedFraction(); >30% change ⇒ page-level jump.
 */
export function treeFingerprint(root: WidgetNode | null | undefined): string {
	const s = treeSample(root).joined;
	if (s === "") return "";
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0").repeat(2);
}

/** node count + first-16 (role,label,bounds) sample used by treeFingerprint / treeChangedFraction. */
export function treeSample(root: WidgetNode | null | undefined): { count: number; sample: string[]; joined: string } {
	if (!root) return { count: 0, sample: [], joined: "" };
	let count = 0;
	const sample: string[] = [];
	const walk = (n: WidgetNode): void => {
		count += 1;
		if (count <= 16) sample.push(`${n.role}|${n.label}|${n.center.x},${n.center.y}`);
		n.children.forEach(walk);
	};
	walk(root);
	return { count, sample, joined: `${count}:${sample.join(";")}` };
}

/**
 * Fraction of the first-16 sampled widget identities that differ between two tree samples.
 * Large node-count deltas also count as a full (page-level) change.
 */
export function treeChangedFraction(prev: { count: number; sample: string[] }, next: { count: number; sample: string[] }): number {
	if (prev.count === 0 && next.count === 0) return 0;
	const a = prev.sample;
	const b = next.sample;
	const n = Math.max(a.length, b.length, 1);
	let diff = 0;
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff += 1;
	if (Math.abs(prev.count - next.count) > Math.max(8, next.count * 0.3)) return 1;
	return diff / n;
}

/**
 * decideLevel (PLAN §1.2): deterministic screenshot-trigger policy. Evaluated after the
 * widget tree is captured (the fingerprint needs it) but before any screenshot is taken —
 * only full-level observations carry an image.
 */
export function decideLevel(input: {
	action: string;
	firstOfTask: boolean;
	actionsSinceFull: number;
	focusChanged: boolean; // frontPid changed since the previous observation (B3 pid check)
	prevBlocked: boolean; // previous observation reported a blocked condition
	treeChanged: number; // treeChangedFraction() result
	hadPrevTree: boolean;
	repeat: boolean; // same (action,target) executed within 3s
	a11yAvailable: boolean;
}): { level: ObservationLevel; reason: string } {
	const i = input;
	if (i.action === "screenshot" || i.action === "activate") {
		return { level: "full", reason: i.action === "activate" ? "activate ⇒ full (PLAN §1.2)" : "explicit screenshot request" };
	}
	if (i.firstOfTask) return { level: "full", reason: "first observation of the task" };
	if (i.focusChanged) return { level: "full", reason: "focus-change ⇒ full" };
	if (i.prevBlocked) return { level: "full", reason: "blocked hit ⇒ full" };
	if (i.actionsSinceFull >= 10) return { level: "full", reason: "heartbeat: ≥10 actions since last full" };
	if (i.hadPrevTree && i.treeChanged > 0.3) return { level: "full", reason: `tree fingerprint changed ${(i.treeChanged * 100).toFixed(0)}% (>30%) ⇒ page jump` };
	if (!i.a11yAvailable) return { level: "minimal", reason: "no a11y backend ⇒ degraded to minimal (PLAN §3)" };
	if (i.repeat) return { level: "minimal", reason: "same (action,target) within 3s ⇒ minimal" };
	return { level: "tree", reason: "default" };
}

export interface BlockInfo {
	kind: "popup" | "focus-change" | "no-progress";
	detail: string; // human- and model-readable
	hint: string; // v3.4: purely factual observation signal — no suggested actions
}

export interface Observation {
	level: ObservationLevel; // v3.1 §1.1
	coordSpace: "raster" | "logical"; // full ⇒ raster (screenshot), tree ⇒ logical (v3.1 §3)
	screenshot?: {
		base64: string;
		width: number;
		height: number; // raster actual size (authoritative coordinate reference)
	};
	widgetTree?: WidgetNode; // v3.1 §3: Swift AX (logical coords)
	treeFingerprint?: string; // v3.1 §1.3: 16-hex tree fingerprint ("(tree)" hash)
	treeNodeCount?: number;
	windows: WindowInfo[];
	blocked: BlockInfo | null;
	stateHash: string; // 16-hex dHash of the screenshot; tree fingerprint when no screenshot
	frontApp?: { appName: string; bundleId: string } | null; // B3 front application
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
		return { kind: "no-progress", detail: "screen unchanged after the action", hint: "动作后屏幕状态无变化（hash 未变）" };
	}
	// focus-change: focused window changed and it is not where we were working.
	if (mutating && focused && prevFocused && focused.appName !== prevFocused.appName) {
		return { kind: "focus-change", detail: `focus moved from ${prevFocused.appName} to ${focused.appName}`, hint: `前台焦点已从 ${prevFocused.appName} 变更至 ${focused.appName}` };
	}
	// popup: focused window was not in the previously listed set of windows.
	if (mutating && focused && knownWindows && !knownWindows.has(windowKey(focused))) {
		return { kind: "popup", detail: `focused window '${focused.title || focused.appName}' is new`, hint: `前台窗口 '${focused.title || focused.appName}' 不在之前的窗口清单中（新出现）` };
	}
	return null;
}

export function windowKey(w: WindowInfo): string {
	return `${w.appName}::${w.title}`;
}

/**
 * Name-based widget lookup (user directive: 控件名匹配优先，坐标兜底).
 * Scoring: exact label 4 > startsWith 3 > includes 2; +1 when clickable.
 * Returns the best match or null; coordinates come from node.center (logical space).
 */
export function findElement(
	root: WidgetNode | null | undefined,
	query: string,
): { node: WidgetNode; score: number } | null {
	if (!root) return null;
	const q = query.trim().toLowerCase();
	if (!q) return null;
	let best: { node: WidgetNode; score: number } | null = null;
	const walk = (n: WidgetNode): void => {
		const label = (n.label || "").trim().toLowerCase();
		if (label) {
			let score = 0;
			if (label === q) score = 4;
			else if (label.startsWith(q)) score = 3;
			else if (label.includes(q)) score = 2;
			if (score > 0) {
				if (n.clickable) score += 1;
				if (!best || score > best.score) best = { node: n, score };
			}
		}
		for (const c of n.children) walk(c);
	};
	walk(root);
	return best;
}
