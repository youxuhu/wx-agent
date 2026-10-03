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
	PlatformAdapter,
	PlatformCapabilities,
	Point,
	ScreenshotResult,
	WindowInfo,
} from "../platform";

const SWIFT_TIMEOUT_MS = 3_000;

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

const WINDOWS_SWIFT = `
import Foundation
import AppKit
let front = NSWorkspace.shared.frontmostApplication
let frontPid = front?.processIdentifier ?? -1
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
  var first = true
  var out: [[String: Any]] = []
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
          let x = b["X"], let y = b["Y"], let wd = b["Width"], let ht = b["Height"] else { continue }
    guard wd >= 60 && ht >= 40 else { continue }
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let title = w[kCGWindowName as String] as? String ?? ""
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    // CGWindowList is ordered front-to-back; the first layer-0 window is the
    // focused one. frontmostApplication's pid alone is unreliable from spawned
    // background processes (may point at an app with no on-screen window).
    out.append([
      "title": title, "appName": owner, "isFocused": first || pid == frontPid,
      "x": Double(x), "y": Double(y), "width": Double(wd), "height": Double(ht),
    ])
    first = false
  }
let d = try! JSONSerialization.data(withJSONObject: out)
print(String(data: d, encoding: .utf8)!)
`;

function runSwift(script: string, timeoutMs = SWIFT_TIMEOUT_MS): string {
	const r = spawnSync("swift", ["-"], { input: script, encoding: "utf8", timeout: timeoutMs });
	if (r.error) throw new Error(`swift failed to run: ${r.error.message}`);
	if (r.status !== 0) {
		throw new Error(`swift exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
	}
	return r.stdout;
}

function runSwiftJSON<T>(script: string, timeoutMs = SWIFT_TIMEOUT_MS): T {
	const out = runSwift(script, timeoutMs).trim();
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
	const member = direct ?? (/^[a-z]$/.test(n) ? n.toUpperCase() : /^[0-9]$/.test(n) ? `Num${n}` : null);
	if (!member) return null;
	const value = (K as unknown as Record<string, unknown>)[member];
	return typeof value === "number" ? (value as unknown as import("@nut-tree-fork/nut-js").Key) : null;
}

export function createAdapter(): PlatformAdapter {
	let lastRaster: { width: number; height: number } = { width: 0, height: 0 };
	let lastLogical: { width: number; height: number } = { width: 0, height: 0 };

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
			const file = await m.screen.capture("shot", m.FileType.PNG, dir);
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
		a11y: false, // Phase 2 (Swift AX snippet)
		clipboard: true,
		notes: ["a11y widget tree lands in Phase 2; observations are screenshot + window list for now"],
	};

	return {
		capabilities,

		async screenSize() {
			return { raster: { ...lastRaster }, logical: { ...lastLogical } };
		},

		async screenshot(): Promise<ScreenshotResult> {
			return takeScreenshot();
		},

		async listWindows(): Promise<WindowInfo[]> {
			const rows = runSwiftJSON<Array<Record<string, unknown>>>(WINDOWS_SWIFT);
			return rows.map((r) => ({
				title: String(r.title ?? ""),
				appName: String(r.appName ?? ""),
				bounds: {
					x: Number(r.x ?? 0),
					y: Number(r.y ?? 0),
					width: Number(r.width ?? 0),
					height: Number(r.height ?? 0),
				},
				isFocused: Boolean(r.isFocused),
			}));
		},

		async moveAndClick(p: Point, button: "left" | "right", double?: boolean): Promise<void> {
			const m = await nut();
			await m.mouse.setPosition(new m.Point(Math.round(p.x), Math.round(p.y)));
			const btn = button === "right" ? m.Button.RIGHT : m.Button.LEFT;
			if (double) await m.mouse.doubleClick(btn);
			else await m.mouse.click(btn);
		},

		async typeText(t: string): Promise<void> {
			const m = await nut();
			await m.keyboard.type(t);
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
