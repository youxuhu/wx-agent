/**
 * notify — native completion notification for pi.
 *
 * Fires when pi settles (finished its run and is waiting for input) and,
 * optionally, when a UI prompt is waiting for an answer. Channels are chosen
 * from what the environment actually supports:
 *   - Terminal.app / generic macOS : desktop notification via osascript + sound
 *   - Kitty                        : OSC 99
 *   - Ghostty / iTerm2 / WezTerm   : OSC 777
 *   - Windows Terminal             : PowerShell toast
 *
 * Config: ~/.pi/agent/notify.json
 *   { "enabled": true, "sound": "Glass", "desktop": true, "events": ["settled"] }
 *   sound: a name from /System/Library/Sounds (macOS), "none" to disable
 *   events: "settled" (run finished) and/or "waiting" (a prompt waits for input)
 *
 * Commands: /notify [status | on | off | test | sound <name> | events <a,b>]
 */
import { execFile } from "node:child_process";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface NotifyConfig {
	enabled: boolean;
	sound: string;
	desktop: boolean;
	events: ("settled" | "waiting")[];
}

/** Honours PI_CODING_AGENT_DIR so test instances do not write into the real agent directory. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "notify.json");
const SOUNDS_DIR = "/System/Library/Sounds";

function soundList(): string[] {
	if (!existsSync(SOUNDS_DIR)) return [];
	return readdirSync(SOUNDS_DIR).filter((f) => f.endsWith(".aiff")).map((f) => f.slice(0, -5));
}

function loadConfig(): NotifyConfig {
	const defaults: NotifyConfig = { enabled: true, sound: "Glass", desktop: true, events: ["settled"] };
	if (!existsSync(CONFIG_PATH)) return defaults;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<NotifyConfig>;
		return {
			enabled: raw.enabled !== false,
			sound: typeof raw.sound === "string" ? raw.sound : defaults.sound,
			desktop: raw.desktop !== false,
			events: Array.isArray(raw.events) && raw.events.length ? (raw.events.filter((e) => e === "settled" || e === "waiting") as NotifyConfig["events"]) : defaults.events,
		};
	} catch {
		return defaults;
	}
}

function saveConfig(config: NotifyConfig): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const osc777 = (title: string, body: string) => `\x1b]777;notify;${title};${body}\x07`;
const osc99 = (title: string, body: string) => `\x1b]99;i=1:d=0;${title}\x1b\\\x1b]99;i=1:p=body;${body}\x1b\\`;

function windowsToast(title: string, body: string): void {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	const script = [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-Command", script]);
}

/** Resolve the channels this environment supports; returned for tests and /notify status. */
function channels(): string[] {
	if (process.platform === "darwin") {
		const out: string[] = [];
		if (process.env.KITTY_WINDOW_ID) out.push("osc99");
		else if (process.env.GHOSTTY_RESOURCES_DIR || process.env.ITERM_SESSION_ID || process.env.WEZTERM_PANE) out.push("osc777");
		out.push("osascript");
		if (existsSync(SOUNDS_DIR)) out.push("sound");
		return out;
	}
	if (process.platform === "win32" || process.env.WT_SESSION) return ["toast"];
	if (process.env.KITTY_WINDOW_ID) return ["osc99"];
	return ["osc777"];
}

function notify(title: string, body: string, config: NotifyConfig): void {
	const chans = channels();
	if (process.platform === "darwin") {
		// desktop notification + optional sound; OSC only when the terminal supports it
		if (chans.includes("osc99")) process.stdout.write(osc99(title, body));
		if (chans.includes("osc777")) process.stdout.write(osc777(title, body));
		if (config.desktop) {
			execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
		}
		if (config.sound && config.sound !== "none") {
			const sound = join(SOUNDS_DIR, `${config.sound}.aiff`);
			if (existsSync(sound)) execFile("afplay", [sound]);
		}
		return;
	}
	if (chans.includes("toast")) windowsToast(title, body);
	else if (chans.includes("osc99")) process.stdout.write(osc99(title, body));
	else process.stdout.write(osc777(title, body));
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async () => {
		const config = loadConfig();
		if (!config.enabled || !config.events.includes("settled")) return;
		notify("pi", "Ready for input", config);
	});

	pi.on("ui_prompt_start", async () => {
		const config = loadConfig();
		if (!config.enabled || !config.events.includes("waiting")) return;
		notify("pi", "Waiting for your answer", config);
	});

	pi.registerCommand("notify", {
		description: "Completion notification: /notify [status|on|off|test|sound <name>|events settled,waiting]",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const config = loadConfig();
			switch (cmd) {
				case undefined:
				case "status": {
					ctx.ui.notify(
						[
							`enabled: ${config.enabled}`,
							`events: ${config.events.join(", ") || "(none)"}`,
							`desktop: ${config.desktop}   sound: ${config.sound}`,
							`channels (this env): ${channels().join(", ")}`,
							`config: ${CONFIG_PATH}`,
							`sounds: ${soundList().join(", ") || "(none)"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				case "on":
				case "off": {
					const next = { ...config, enabled: cmd === "on" };
					saveConfig(next);
					ctx.ui.notify(`notify ${next.enabled ? "enabled" : "disabled"}`, "info");
					return;
				}
				case "test": {
					notify("pi", "test notification", { ...config, enabled: true });
					ctx.ui.notify(`test sent via ${channels().join(", ")}`, "info");
					return;
				}
				case "sound": {
					if (!arg) return ctx.ui.notify(`usage: /notify sound <name|none> — available: ${soundList().join(", ") || "(none)"}`, "warning");
					if (arg !== "none" && soundList().length > 0 && !soundList().includes(arg)) {
						return ctx.ui.notify(`unknown sound '${arg}'; available: ${soundList().join(", ")}, none`, "warning");
					}
					const next = { ...config, sound: arg };
					saveConfig(next);
					ctx.ui.notify(`sound set to ${arg}`, "info");
					return;
				}
				case "events": {
					const events = (arg || "").split(",").map((s) => s.trim()).filter((s) => s === "settled" || s === "waiting") as NotifyConfig["events"];
					if (!events.length) return ctx.ui.notify("usage: /notify events settled,waiting", "warning");
					const next = { ...config, events };
					saveConfig(next);
					ctx.ui.notify(`events set to ${events.join(", ")}`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown arg '${cmd}'. Use: status | on | off | test | sound <name> | events settled,waiting`, "warning");
			}
		},
	});
}
