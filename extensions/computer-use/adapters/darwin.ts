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
    "title": title, "appName": owner, "isFocused": pid == frontPid,
    "x": Double(x), "y": Double(y), "width": Double(wd), "height": Double(ht),
  ])
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

let nutPromise: Promise<NutModule> | null = null;
async function nut(): Promise<NutModule> {
	if (!nutPromise) {
		nutPromise = import("@nut-tree-fork/nut-js").then((m) => {
			m.screen.config.autoHighlight = false;
			m.mouse.config.autoDelayMs = 50;
			m.mouse.config.mouseSpeed = 3000;
			return m;
		});
	}
	return nutPromise;
}

/** Map a "cmd+c"-style combo to nut.js Key values (PLAN §3.1 key action). */
function mapKey(name: string): import("@nut-tree-fork/nut-js").Key | null {
	const n = name.toLowerCase();
	const map: Record<string, import("@nut-tree-fork/nut-js").Key> = {
		cmd: "Key.LeftCmd" as never,
		command: "Key.LeftCmd" as never,
		meta: "Key.LeftCmd" as never,
		ctrl: "Key.LeftControl" as never,
		control: "Key.LeftControl" as never,
		alt: "Key.LeftAlt" as never,
		option: "Key.LeftAlt" as never,
		shift: "Key.LeftShift" as never,
		enter: "Key.Return" as never,
		return: "Key.Return" as never,
		esc: "Key.Escape" as never,
		escape: "Key.Escape" as never,
		tab: "Key.Tab" as never,
		space: "Key.Space" as never,
		backspace: "Key.Backspace" as never,
		delete: "Key.Delete" as never,
		up: "Key.Up" as never,
		down: "Key.Down" as never,
		left: "Key.Left" as never,
		right: "Key.Right" as never,
	};
	if (map[n]) return map[n];
	const fn = /^f([1-9]|1[0-2])$/.exec(n);
	if (fn) return (`Key.F${fn[1]}` as never) as import("@nut-tree-fork/nut-js").Key;
	return null;
}

export function createAdapter(): PlatformAdapter {
	let lastRaster: { width: number; height: number } = { width: 0, height: 0 };
	let lastLogical: { width: number; height: number } = { width: 0, height: 0 };

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
				const rasterW = img.bitmap.width;
				const rasterH = img.bitmap.height;
				const { stateHash } = await import("../gate");
				const hash = stateHash(img.bitmap.data, rasterW, rasterH);
				const scale = rasterW > 1280 ? 1280 / rasterW : 1;
				const jpeg = await img
					.resize(Math.round(rasterW * scale), Math.round(rasterH * scale))
					.quality(60)
					.getBufferAsync("image/jpeg" as never);
				lastRaster = { width: rasterW, height: rasterH };
				lastLogical = { width: logicalW, height: logicalH };
				return { width: rasterW, height: rasterH, jpeg, hash };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
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
			const keys: import("@nut-tree-fork/nut-js").Key[] = [];
			const loose: string[] = [];
			for (const part of parts) {
				const k = mapKey(part);
				if (k) keys.push(k);
				else loose.push(part);
			}
			if (keys.length > 0) {
				await m.keyboard.pressKey(...keys);
				return;
			}
			// Single loose character(s): type them directly.
			await m.keyboard.type(loose.join(""));
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
			return { items };
		},
	};
}
