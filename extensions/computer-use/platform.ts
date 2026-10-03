/**
 * platform.ts — PlatformAdapter interface, platform detection and adapter factory (PLAN §4).
 */

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowInfo {
	pid: number; // owning process id
	title: string;
	appName: string; // owning application
	bounds: Rect; // global screen (logical) coordinates
	isFocused: boolean; // v3.1 (PLAN §2.3): true iff pid === frontPid
}

/** Front application snapshot from the B3 cross-check Swift probe (PLAN §2.3). */
export interface FrontAppInfo {
	pid: number;
	appName: string;
	bundleId: string;
}

export interface PlatformCapabilities {
	platform: "darwin" | "linux-x11" | "linux-wayland" | "win32" | "wsl";
	screenshot: boolean; // screenshot available
	mouseKeyboard: boolean; // input injection available
	a11y: boolean; // a11y tree available (always false before Phase 2)
	clipboard: boolean;
	notes: string[]; // user-readable notes about missing capabilities (goes into /cua output)
}

export interface DoctorItem {
	ok: boolean;
	label: string;
	detail?: string;
	fix?: string; // remediation hint shown for failing items
}

export interface DoctorReport {
	items: DoctorItem[];
}

export interface ScreenshotResult {
	width: number; // raster width (authoritative coordinate space)
	height: number; // raster height
	jpeg: Buffer; // JPEG, width <=1280, q60
	hash: string; // dHash 8x8 of the raster, 16 hex (gate.stateHash)
}

/**
 * PlatformAdapter — per-platform execution backend.
 * Implementations must never require new npm dependencies beyond @nut-tree-fork/nut-js;
 * platform snippets (Swift/PowerShell/python) are embedded template strings fed via stdin.
 */
export interface PlatformAdapter {
	readonly capabilities: PlatformCapabilities;
	/** B3 (PLAN §2.3): front application cross-check (frontPid/frontApp/frontBundleId). */
	frontmostApp(): Promise<FrontAppInfo | null>;
	/** B2/B4 (PLAN §2.2/§2.4): activate an app to the foreground (name or bundleId). */
	activateApp(target: string): Promise<void>;
	/** v3.5 §2.1: installed apps (name/bundleId/path) — pure fact for the model. */
	listApps(): Promise<{ name: string; bundleId: string; path: string }[]>;
	/** Main display raster size of the last/current capture and logical size, for Retina conversion. */
	screenSize(): Promise<{ raster: { width: number; height: number }; logical: { width: number; height: number } }>;
	screenshot(): Promise<ScreenshotResult>;
	listWindows(): Promise<WindowInfo[]>;
	moveAndClick(p: Point, button: "left" | "right", double?: boolean): Promise<void>;
	typeText(t: string): Promise<void>;
	pressKey(combo: string): Promise<void>;
	scroll(d: "up" | "down", amount: number, at?: Point): Promise<void>;
	a11yTree?(): Promise<import("./gate").WidgetNode | null>; // §3 Swift AX backend
	doctor(): Promise<DoctorReport>;
}

export type SupportedPlatform = PlatformCapabilities["platform"];

/** Detects the concrete platform per PLAN §4 probe table. */
export function detectPlatform(): SupportedPlatform {
	const p = process.platform;
	if (p === "darwin") return "darwin";
	if (p === "win32") return "win32";
	if (p === "linux") {
		if (process.env.WSL_DISTRO_NAME) return "wsl";
		if (process.env.WAYLAND_DISPLAY) return "linux-wayland";
		if (process.env.XDG_SESSION_TYPE === "x11" || process.env.DISPLAY) return "linux-x11";
		return "linux-wayland";
	}
	return "linux-x11";
}

/**
 * Adapter factory. On this Phase-1 milestone only darwin is implemented;
 * linux-x11 / linux-wayland / win32 / wsl return unsupported stubs.
 */
export async function createAdapter(): Promise<PlatformAdapter> {
	switch (detectPlatform()) {
		case "darwin": {
			const m = await import("./adapters/darwin");
			return m.createAdapter();
		}
		case "linux-x11": {
			const m = await import("./adapters/linux-x11");
			return m.createAdapter();
		}
		case "linux-wayland": {
			const m = await import("./adapters/linux-wl");
			return m.createAdapter();
		}
		case "win32": {
			const m = await import("./adapters/win32");
			return m.createAdapter();
		}
		case "wsl": {
			const m = await import("./adapters/wsl");
			return m.createAdapter();
		}
	}
}

/** Helper used by stub adapters. */
export function unsupportedAdapter(platform: SupportedPlatform, note: string, phase: string): PlatformAdapter {
	const err = () => {
		throw new Error(`computer: platform '${platform}' is not supported yet (${phase}). ${note}`);
	};
	return {
		capabilities: {
			platform,
			screenshot: false,
			mouseKeyboard: false,
			a11y: false,
			clipboard: false,
			notes: [note],
		},
		frontmostApp: err,
		activateApp: err,
		listApps: err,
		screenSize: err,
		screenshot: err,
		listWindows: err,
		moveAndClick: err,
		typeText: err,
		pressKey: err,
		scroll: err,
		doctor: async () => ({
			items: [{ ok: false, label: `${platform} adapter`, detail: "not implemented", fix: phase }],
		}),
	};
}
