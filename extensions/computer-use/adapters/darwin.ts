/**
 * adapters/darwin.ts — macOS backend (PLAN §4/§5.1).
 *
 * Input injection (mouse/keyboard) via @nut-tree-fork/nut-js (libnut prebuilt binaries).
 * Screenshots via nut.js `screen.capture` (PNG temp file) + jimp (bundled dependency of
 * nut-js, NOT a new npm dependency) for scale-to-width<=1280 + JPEG q60 encoding.
 * Window listing and permission (doctor) checks via small embedded Swift snippets,
 * spawned with `swift -` + stdin, always with a 3s timeout (read-pdf pattern, no temp files).
 *
 * Coordinate note (Retina): the raster returned by screenshot() is authoritative for x/y
 * parameters; callers convert raster -> logical via screenSize(). raster/logical.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DoctorReport,
	FrontAppInfo,
	PlatformAdapter,
	PlatformCapabilities,
	Point,
	ScreenshotResult,
	WindowInfo,
} from "../platform";
import { mergeRawAx, type RawAxNode } from "../gate";

const SWIFT_TIMEOUT_MS = 3_000;
const AX_TIMEOUT_MS = 2_000; // PLAN §3: AX snippet hard timeout

const DOCTOR_SWIFT = `
import Foundation
import ApplicationServices
import CoreGraphics
let ax = AXIsProcessTrusted()
let screen = CGPreflightScreenCaptureAccess()
let b = CGDisplayBounds(CGMainDisplayID())
let result: [String: Any] = [
  "ax": ax,
  "screenRecording": screen,
  "logicalWidth": Double(b.width),
  "logicalHeight": Double(b.height),
]
let d = try! JSONSerialization.data(withJSONObject: result)
print(String(data: d, encoding: .utf8)!)
`;

/**
 * B3 (PLAN §2.3): one-shot probe returning the front application (frontmostApplication —
 * authoritative) plus the layer-0 on-screen window list. isFocused is decided by the
 * CALLER from pid === frontPid; the Swift side no longer uses CGWindowList order heuristics.
 */
const WINDOWS_SWIFT = `
import Foundation
import AppKit
let front = NSWorkspace.shared.frontmostApplication
let frontPid = front?.processIdentifier ?? -1
let frontApp = front?.localizedName ?? ""
let frontBundleId = front?.bundleIdentifier ?? ""
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
  var out: [[String: Any]] = []
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
          let x = b["X"], let y = b["Y"], let wd = b["Width"], let ht = b["Height"] else { continue }
    guard wd >= 60 && ht >= 40 else { continue }
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let title = w[kCGWindowName as String] as? String ?? ""
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    out.append([
      "pid": pid, "title": title, "appName": owner,
      "x": Double(x), "y": Double(y), "width": Double(wd), "height": Double(ht),
    ])
  }
let result: [String: Any] = [
  "frontPid": frontPid, "frontApp": frontApp, "frontBundleId": frontBundleId, "windows": out,
]
let d = try! JSONSerialization.data(withJSONObject: result)
print(String(data: d, encoding: .utf8)!)
`;

interface WindowsProbe {
	frontPid: number;
	frontApp: string;
	frontBundleId: string;
	windows: Array<{ pid: number; title: string; appName: string; x: number; y: number; width: number; height: number }>;
}

/**
 * §3: AX widget-tree dump. Reads the target pid embedded at template time
 * (omitted pid → frontmost app). Depth <=12 / nodes <=400 enforced here;
 * the caller additionally enforces the 2s spawnSync timeout.
 */
const AX_SWIFT = (pid: number) => `
import Foundation
import AppKit
import ApplicationServices
let MAX_DEPTH = 12
let MAX_NODES = 400
let targetPid: pid_t = ${Number.isInteger(pid) && pid > 0 ? pid : "NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1"}
var nodeCount = 0
func axString(_ el: AXUIElement, _ attr: String) -> String {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let s = v as? String else { return "" }
  return s
}
func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let b = v as? Bool else { return false }
  return b
}
func axGeom(_ el: AXUIElement, _ attr: String) -> [String: Double]? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, v != nil, CFGetTypeID(v!) == AXValueGetTypeID() else { return nil }
  let av = v! as! AXValue
  let t = AXValueGetType(av)
  if t == .cgPoint {
    var p = CGPoint.zero
    guard AXValueGetValue(av, .cgPoint, &p) else { return nil }
    return ["x": Double(p.x), "y": Double(p.y)]
  }
  if t == .cgSize {
    var s = CGSize.zero
    guard AXValueGetValue(av, .cgSize, &s) else { return nil }
    return ["w": Double(s.width), "h": Double(s.height)]
  }
  return nil
}
func walk(_ el: AXUIElement, _ depth: Int) -> [String: Any]? {
  if depth > MAX_DEPTH || nodeCount >= MAX_NODES { return nil }
  nodeCount += 1
  let role = axString(el, kAXRoleAttribute as String)
  let title = axString(el, kAXTitleAttribute as String)
  var value = axString(el, kAXValueAttribute as String)
  if value.count > 80 { value = String(value.prefix(80)) }
  let pos = axGeom(el, kAXPositionAttribute as String)
  let size = axGeom(el, kAXSizeAttribute as String)
  let focused = axBool(el, kAXFocusedAttribute as String)
  var children: [[String: Any]] = []
  if depth < MAX_DEPTH, nodeCount < MAX_NODES {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
       let arr = v as? [AXUIElement] {
      for c in arr {
        if let n = walk(c, depth + 1) { children.append(n) }
        if nodeCount >= MAX_NODES { break }
      }
    }
  }
  var d: [String: Any] = ["role": role, "title": title, "value": value, "focused": focused]
  if let p = pos { d["x"] = p["x"] ?? 0; d["y"] = p["y"] ?? 0 }
  if let s = size { d["w"] = s["w"] ?? 0; d["h"] = s["h"] ?? 0 }
  if !children.isEmpty { d["children"] = children }
  return d
}
let app = AXUIElementCreateApplication(targetPid)
var root: [String: Any] = [:]
if let tree = walk(app, 0) { root = tree }
let result: [String: Any] = ["ok": nodeCount > 0, "pid": targetPid, "nodes": nodeCount, "tree": root]
let d = try! JSONSerialization.data(withJSONObject: result)
print(String(data: d, encoding: .utf8)!)
`;

interface RawAxNode {
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

/**
 * B2/B4 (PLAN §2.2/§2.4): activate by pid (NSRunningApplication) → open -b → open -a.
 * The target (name or bundleId) is passed via the CUA_TARGET env var; the Swift side
 * resolves it against NSWorkspace.runningApplications and activates by pid.
 */
const ACTIVATE_SWIFT = `
import Foundation
import AppKit
import ApplicationServices
let target = ProcessInfo.processInfo.environment["CUA_TARGET"] ?? ""
var best: NSRunningApplication? = nil
if !target.isEmpty {
  let t = target.lowercased()
  for a in NSWorkspace.shared.runningApplications {
    guard a.activationPolicy == .regular else { continue }
    let name = a.localizedName?.lowercased() ?? ""
    // exact match first; then prefix/contains so "safari" hits "Safari浏览器"
    if a.bundleIdentifier == target || a.localizedName == target || name == t
       || name.hasPrefix(t) || name.contains(t) { best = a; break }
  }
}
var ok = false
var pid: Int32 = -1
var appName = ""
var bundleId = ""
if let a = best {
  var opts: NSApplication.ActivationOptions = [.activateAllWindows]
  ok = a.activate(options: opts)
  pid = a.processIdentifier
  appName = a.localizedName ?? ""
  bundleId = a.bundleIdentifier ?? ""
  // Un-minimize: a minimized frontmost app reports focus but has no on-screen
  // window (the trap that hit the Music test) — restore via AX so clicks land.
  if pid > 0 {
    let appEl = AXUIElementCreateApplication(pid)
    var winsRef: CFTypeRef?
    let axErr = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winsRef)
    if axErr == .success, let wins = winsRef as? [AXUIElement] {
      for w in wins {
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
      }
    }
  }
}
let result: [String: Any] = ["ok": ok, "pid": pid, "appName": appName, "bundleId": bundleId]
let d = try! JSONSerialization.data(withJSONObject: result)
print(String(data: d, encoding: .utf8)!)
`;

function runSwift(script: string, timeoutMs = SWIFT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): string {
	const r = spawnSync("swift", ["-"], { input: script, encoding: "utf8", timeout: timeoutMs, env: env ? { ...process.env, ...env } : undefined });
	if (r.error) throw new Error(`swift failed to run: ${r.error.message}`);
	if (r.status !== 0) {
		throw new Error(`swift exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
	}
	return r.stdout;
}

function runSwiftJSON<T>(script: string, timeoutMs = SWIFT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): T {
	const out = runSwift(script, timeoutMs, env).trim();
	const line = out.split("\n").pop() ?? "";
	return JSON.parse(line) as T;
}

type NutModule = typeof import("@nut-tree-fork/nut-js");
let KeyEnum: NutModule["Key"] | null = null;   // resolved on first nut() call

let nutPromise: Promise<NutModule> | null = null;
async function nut(): Promise<NutModule> {
	if (!nutPromise) {
		nutPromise = import("@nut-tree-fork/nut-js").then((m) => {
			KeyEnum = m.Key;
			m.screen.config.autoHighlight = false;
			m.mouse.config.autoDelayMs = 50;
			m.mouse.config.mouseSpeed = 3000;
			return m;
		});
	}
	return nutPromise;
}

/**
 * Map a "cmd+c"-style combo part to a nut.js Key enum VALUE.
 * Key is a NUMERIC enum (Key.C === 90) — the string form "Key.C" is invalid.
 * Top-row digits have no enum member; combos map them to the numpad twin
 * (Num0..Num9), which emits the same character for modifier shortcuts.
 */
function mapKey(name: string): import("@nut-tree-fork/nut-js").Key | null {
	const n = name.toLowerCase();
	const K = KeyEnum;
	const named: Record<string, string> = {
		cmd: "LeftCmd", command: "LeftCmd", meta: "LeftCmd",
		ctrl: "LeftControl", control: "LeftControl",
		alt: "LeftAlt", option: "LeftAlt", opt: "LeftAlt",
		shift: "LeftShift",
		enter: "Return", return: "Return",
		esc: "Escape", escape: "Escape",
		tab: "Tab", space: "Space",
		backspace: "Backspace", delete: "Delete",
		up: "Up", down: "Down", left: "Left", right: "Right",
	};
	const direct = named[n] ?? (/^f([1-9]|1[0-2])$/.exec(n) ? `F${n.slice(1)}` : null);
	const member = direct ?? PUNCT[n] ?? (/^[a-z]$/.test(n) ? n.toUpperCase() : /^[0-9]$/.test(n) ? `Num${n}` : null);
	if (!member) return null;
	const value = (K as unknown as Record<string, unknown>)[member];
	return typeof value === "number" ? (value as unknown as import("@nut-tree-fork/nut-js").Key) : null;
}

/** ASCII printable single characters mappable to nut.js Key enum members (B1 extension). */
const PUNCT: Record<string, string> = {
	".": "Period", ",": "Comma", "/": "Slash", ";": "Semicolon", "'": "Quote",
	"-": "Minus", "=": "Equal", "[": "LeftBracket", "]": "RightBracket",
	"\\": "Backslash", "`": "Grave",
};

export function createAdapter(): PlatformAdapter {
	let lastRaster: { width: number; height: number } = { width: 0, height: 0 };
	let lastLogical: { width: number; height: number } = { width: 0, height: 0 };
	let frontCache: { at: number; value: WindowsProbe } | null = null;

	/**
	 * Screenshot pipeline (PLAN §3.1/§3.3): capture PNG, scale to width ≤ 1280,
	 * hash + report the SCALED raster dims — the model's coordinate system is the
	 * returned image, so width/height must describe what the model actually sees.
	 */
	async function takeScreenshot(): Promise<ScreenshotResult> {
		const m = await nut();
		// Logical main-display size (nut.js reports points on macOS, not pixels).
		let logicalW = 0;
		let logicalH = 0;
		try {
			logicalW = await m.screen.width();
			logicalH = await m.screen.height();
		} catch {
			/* fall through to doctor-time values */
		}
		const dir = mkdtempSync(join(tmpdir(), "cua-shot-"));
		try {
			let file: string;
			try {
				file = await m.screen.capture("shot", m.FileType.PNG, dir);
			} catch {
				// macOS 15+ obsoleted CGDisplayCreateImage, which libnut uses — fall back to
				// the system screencapture(1) CLI (same Screen Recording permission).
				file = join(dir, "shot.png");
				const cap = spawnSync("screencapture", ["-x", "-t", "png", file], { timeout: SWIFT_TIMEOUT_MS });
				if (cap.status !== 0) throw new Error(`screenshot failed: nut.capture + screencapture both unavailable`);
			}
			const { default: Jimp } = await import("jimp");
			const img = await Jimp.read(file);
			const rawW = img.bitmap.width;
			const rawH = img.bitmap.height;
			const scale = rawW > 1280 ? 1280 / rawW : 1;
			if (scale < 1) img.resize(Math.round(rawW * scale), Math.round(rawH * scale));
			const { width: outW, height: outH, data } = img.bitmap;
			const { stateHash } = await import("../gate");
			const hash = stateHash(data, outW, outH);
			const jpeg = await img.quality(60).getBufferAsync("image/jpeg" as never);
			lastRaster = { width: outW, height: outH };
			lastLogical = { width: logicalW, height: logicalH };
			return { width: outW, height: outH, jpeg, hash };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	const capabilities: PlatformCapabilities = {
		platform: "darwin",
		screenshot: true,
		mouseKeyboard: true,
		a11y: true, // §3 Swift AX widget tree (logical screen coordinates)
		clipboard: true,
		notes: [],
	};

	return {
		capabilities,

		/** Cached (500ms) WINDOWS_SWIFT probe — avoids re-spawning swift between listWindows + frontmostApp. */
		async frontProbe(): Promise<WindowsProbe> {
			const now = Date.now();
			if (frontCache && now - frontCache.at < 500) return frontCache.value;
			const value = runSwiftJSON<WindowsProbe>(WINDOWS_SWIFT);
			frontCache = { at: now, value };
			return value;
		},

		async screenSize() {
			return { raster: { ...lastRaster }, logical: { ...lastLogical } };
		},

		async screenshot(): Promise<ScreenshotResult> {
			return takeScreenshot();
		},

		async listWindows(): Promise<WindowInfo[]> {
			const probe = await this.frontProbe();
			return probe.windows.map((r) => ({
				pid: r.pid,
				title: r.title,
				appName: r.appName,
				bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
				// B3 (PLAN §2.3): focus is decided ONLY by pid === frontPid.
				isFocused: r.pid === probe.frontPid,
			}));
		},

		async frontmostApp(): Promise<FrontAppInfo | null> {
			const probe = await this.frontProbe();
			if (probe.frontPid < 0 && !probe.frontApp) return null;
			return { pid: probe.frontPid, appName: probe.frontApp, bundleId: probe.frontBundleId };
		},

		/**
		 * B2/B4 (PLAN §2.2/§2.4): activate an app by name or bundleId.
		 * Order: NSRunningApplication(pid).activate() → open -b <bundleId> → open -a <name>.
		 */
		async activateApp(target: string): Promise<void> {
			const t = target.trim();
			if (!t) throw new Error("activateApp: empty target");
			// NSRunningApplication.activate can transiently return false when the
			// caller is a background process (macOS activation race) — retry once
			// with [.activateAllWindows], then fall through to open(1) fallbacks.
			for (const force of ["", "1"]) {
				try {
					const r = runSwiftJSON<{ ok: boolean; pid: number }>(ACTIVATE_SWIFT, SWIFT_TIMEOUT_MS, {
						CUA_TARGET: t,
						CUA_FORCE: force,
					});
					if (r.ok) return;
				} catch {
					break; // swift itself failed (compile/runtime) — open(1) fallbacks
				}
				await new Promise((res) => setTimeout(res, 300));
			}
			const tryOpen = (args: string[]): boolean => {
				const r = spawnSync("open", args, { timeout: SWIFT_TIMEOUT_MS });
				return r.status === 0;
			};
			if (t.includes(".") && tryOpen(["-b", t])) return;
			if (tryOpen(["-a", t])) return;
			if (!t.includes(".") && tryOpen(["-b", t])) return;
			throw new Error(`activateApp: could not activate '${t}'`);
		},

		/** §3: Swift AX dump → raw JSON tree (logical screen coordinates). */
		async a11yTree(): Promise<import("../gate").WidgetNode | null> {
			let pid = -1;
			try {
				const front = await this.frontmostApp();
				pid = front?.pid ?? -1;
			} catch {
				/* frontmost probe failed — let Swift resolve the front app itself */
			}
			const script = AX_SWIFT(pid > 0 ? pid : 0);
			const r = spawnSync("swift", ["-"], { input: script, encoding: "utf8", timeout: AX_TIMEOUT_MS });
			if (r.error || r.status !== 0) return null; // AX unavailable/slow → caller degrades the level
			try {
				const parsed = JSON.parse((r.stdout || "").trim().split("\n").pop() ?? "") as { ok: boolean; tree: RawAxNode };
				if (!parsed.ok || !parsed.tree) return null;
				return mergeRawAx(parsed.tree);
			} catch {
				return null;
			}
		},

		async moveAndClick(p: Point, button: "left" | "right", double?: boolean): Promise<void> {
			const m = await nut();
			await m.mouse.setPosition(new m.Point(Math.round(p.x), Math.round(p.y)));
			const btn = button === "right" ? m.Button.RIGHT : m.Button.LEFT;
			if (double) await m.mouse.doubleClick(btn);
			else await m.mouse.click(btn);
		},

/**
 * B1 (PLAN §2.1): per-character pressKey typing. nut.js keyboard.type silently drops
 * text in this environment; pressKey is the verified path. Newline → Return;
 * mappable ASCII → pressKey (uppercase via Shift+twin); unmappable chars (CJK/emoji)
 * fall back to keyboard.type for that single character.
 */
		async typeText(t: string): Promise<void> {
			const m = await nut();
			// CJK/emoji/other non-ASCII: keyboard.type is unreliable on this box
			// (B1) — route through clipboard+paste instead, preserving the old
			// clipboard around the paste.
			const asciiOnly = /^[\x20-\x7E]*$/.test(t);
			if (!asciiOnly && !t.includes("\n")) {
				const prev = spawnSync("pbpaste", { encoding: "utf8", timeout: 3_000 }).stdout ?? "";
				const copy = spawnSync("pbcopy", { input: t, timeout: 3_000 });
				if (copy.status !== 0) throw new Error("typeText: pbcopy failed");
				await this.pressKey("cmd+v");
				await new Promise((r) => setTimeout(r, 150));
				if (prev) spawnSync("pbcopy", { input: prev, timeout: 3_000 });
				return;
			}
			for (const ch of t) {
				if (ch === "\n") {
					await m.keyboard.pressKey(m.Key.Return);
					continue;
				}
				if (/[A-Z]/.test(ch)) {
					const k = mapKey(ch.toLowerCase());
					if (typeof k === "number") {
						await m.keyboard.pressKey(m.Key.LeftShift, k as import("@nut-tree-fork/nut-js").Key);
						continue;
					}
				}
				const k = mapKey(ch);
				if (typeof k === "number") await m.keyboard.pressKey(k as import("@nut-tree-fork/nut-js").Key);
				else await m.keyboard.type(ch); // unmappable ASCII edge — single-char fallback
			}
		},

		async pressKey(combo: string): Promise<void> {
			const m = await nut();
			const parts = combo.split("+").map((s) => s.trim()).filter(Boolean);
			const keys = parts.map((p) => mapKey(p));
			if (keys.length > 0 && keys.every((k) => typeof k === "number")) {
				// All parts resolved to enum values — press the combo atomically.
				await m.keyboard.pressKey(...(keys as import("@nut-tree-fork/nut-js").Key[]));
				return;
			}
			// Unresolvable combo: fall back to typing the literal text (minus separators).
			await m.keyboard.type(parts.join(""));
		},

		async scroll(d: "up" | "down", amount: number, at?: Point): Promise<void> {
			const m = await nut();
			if (at) await m.mouse.setPosition(new m.Point(Math.round(at.x), Math.round(at.y)));
			if (d === "up") await m.mouse.scrollUp(amount);
			else await m.mouse.scrollDown(amount);
		},

		async doctor(): Promise<DoctorReport> {
			const items: DoctorReport["items"] = [];
			let logical: { width: number; height: number } | null = null;
			try {
				const r = runSwiftJSON<{ ax: boolean; screenRecording: boolean; logicalWidth: number; logicalHeight: number }>(
					DOCTOR_SWIFT,
				);
				logical = { width: r.logicalWidth, height: r.logicalHeight };
				items.push({
					ok: r.ax,
					label: "Accessibility permission (AXIsProcessTrusted)",
					detail: r.ax ? "granted" : "not granted",
					fix: r.ax
						? undefined
						: "System Settings → Privacy & Security → Accessibility → enable the terminal/pi host process.",
				});
				items.push({
					ok: r.screenRecording,
					label: "Screen Recording permission (CGPreflightScreenCaptureAccess)",
					detail: r.screenRecording ? "granted" : "not granted",
					fix: r.screenRecording
						? undefined
						: "System Settings → Privacy & Security → Screen Recording → enable the terminal/pi host process, then restart it.",
				});
			} catch (e) {
				items.push({
					ok: false,
					label: "Swift doctor probe",
					detail: e instanceof Error ? e.message : String(e),
					fix: "Ensure Xcode Command Line Tools are installed (xcode-select --install).",
				});
			}
			try {
				const m = await nut();
				const w = await m.screen.width();
				const h = await m.screen.height();
				items.push({ ok: true, label: "nut.js input backend", detail: `main display ${w}x${h} (logical)` });
			} catch (e) {
				items.push({
					ok: false,
					label: "nut.js input backend",
					detail: e instanceof Error ? e.message : String(e),
					fix: "Run: npm i --prefix ~/.pi/agent @nut-tree-fork/nut-js",
				});
			}
		if (logical) {
			items.push({ ok: true, label: "Main display (logical)", detail: `${logical.width}x${logical.height}` });
		}
		// Content check: with Screen Recording missing-but-granted races (needs host
		// restart), captures still "succeed" but contain no window content — the
		// dHash collapses to a degenerate value. Catch that case explicitly.
		try {
			const shot = await takeScreenshot();
			const degenerate = /^([0-9a-f])\1+$/.test(shot.hash);
			items.push({
				ok: !degenerate,
				label: "Screenshot content check",
				detail: degenerate
					? `degenerate hash ${shot.hash} — window contents likely missing`
					: `ok (${shot.width}x${shot.height}, hash ${shot.hash.slice(0, 8)}…)`,
				fix: degenerate
					? "Screen Recording permission needs the pi host process to restart to take effect."
					: undefined,
			});
		} catch (e) {
			items.push({
				ok: false,
				label: "Screenshot content check",
				detail: e instanceof Error ? e.message : String(e),
			});
		}
		return { items };
		},
	};
}
