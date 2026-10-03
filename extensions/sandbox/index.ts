/**
 * sandbox — OS-level sandboxing for bash commands.
 *
 * Applies kernel-enforced filesystem and network policy to every bash command
 * and all of its child processes (macOS `sandbox-exec`, Linux `bubblewrap`),
 * via `@anthropic-ai/sandbox-runtime`. This replaces the previous policy-layer
 * extension, which only gated the write/edit tools and could be bypassed by any
 * shell redirection; the per-call approval ability moved to the `policy`
 * extension instead.
 *
 * Config (merged, project wins):
 *   ~/.pi/agent/sandbox.json      (global)
 *   <cwd>/.pi/sandbox.json        (project)
 *
 *   {
 *     "enabled": true,
 *     "network":    { "allowedDomains": [...], "deniedDomains": [] },
 *     "filesystem": { "denyRead": [...], "allowWrite": [...], "denyWrite": [...] }
 *   }
 *
 * Legacy `{ "mode": "bypass" | "ask", "allowedPaths": [...] }` is migrated:
 * `bypass` → enabled:false, `ask` → enabled:true and allowedPaths appended to
 * filesystem.allowWrite. The old file is backed up next to the new one.
 *
 * Commands: /sandbox [status | on | off | allow-domain <d> | allow-path <p> | violations]
 * Flag:     --no-sandbox  (disable for this run)
 *
 * Measured (2026-10-03): filesystem policy enforced for every bash child (writes
 * outside allowWrite and reads of denyRead paths are denied); allowlisted egress works
 * (curl/npm/git) and non-allowlisted egress is blocked. `/sandbox violations` shows
 * denials; `/sandbox allow-domain <d>` / `allow-path <p>` widen the policy.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, CONFIG_DIR_NAME, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
	/** command substrings that run OUTSIDE the sandbox (e.g. screencapture: macOS never grants
	 *  screen-recording TCC to a seatbelt-sandboxed process). Documented, config-driven, and
	 *  reported as a fact when it happens. */
	unsandboxedCommands?: string[];
}
const CONFIG_PATH = join(getAgentDir(), "sandbox.json");

function expandPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

const DEFAULT_CONFIG: SandboxConfig = {
	// Filesystem and network policy are enforced for bash and all of its children.
	// Measured 2026-10-03: allowlisted egress works (curl 200, npm install, git ls-remote),
	// non-allowlisted egress is blocked, writes outside allowWrite and reads of denyRead
	// path are denied. Note: a synchronous test harness (spawnSync) blocks the host
	// process that hosts the proxy and makes egress look broken — real usage is async.
	enabled: true,
	// screencapture cannot work inside the sandbox: macOS never grants screen-recording
	// (TCC/WindowServer) to a sandboxed process, so it runs unsandboxed by default.
	unsandboxedCommands: ["screencapture"],
	network: {
		allowedDomains: [
			// model provider in use (see ~/.pi/agent/models-store.json)
			"open.bigmodel.cn",
			// source hosting + package registries
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"registry.npmjs.org",
			"*.npmjs.org",
			"pypi.org",
			"*.pypi.org",
		],
		deniedDomains: [],
		allowLocalBinding: true,
		// DNS resolution inside the sandbox goes through mDNSResponder
		allowMachLookup: ["com.apple.mDNSResponder", "com.apple.dnssd", "com.apple.system.opendirectoryd.libinfo"],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		// "." = session cwd; ~/.pi keeps pi's own config/extensions writable;
		// /private/var/folders is macOS TMPDIR (screencapture, temp files)
		allowWrite: [".", "/tmp", "/private/tmp", "/private/var/folders", "~/.pi", "~/Library/Caches", "~/.npm"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };
	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) result.network = { ...base.network, ...overrides.network };
	if (overrides.filesystem) result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	if (overrides.ignoreViolations) result.ignoreViolations = overrides.ignoreViolations;
	if (overrides.enableWeakerNestedSandbox !== undefined) result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
	if (Array.isArray(overrides.unsandboxedCommands)) result.unsandboxedCommands = overrides.unsandboxedCommands;
	return result;
}

/** Read config, migrating the legacy policy-layer shape when encountered. */
function loadConfig(cwd: string): SandboxConfig {
	const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
	let global: Partial<SandboxConfig> = {};
	let project: Partial<SandboxConfig> = {};

	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
			if (raw.mode !== undefined && raw.enabled === undefined) {
				// legacy { mode, allowedPaths } — migrate in place, keep a backup
				const legacyMode = String(raw.mode);
				const paths = Array.isArray(raw.allowedPaths) ? (raw.allowedPaths as string[]).map(expandPath) : [];
				const migrated: SandboxConfig = deepMerge(DEFAULT_CONFIG, { enabled: legacyMode === "ask" });
				if (paths.length) migrated.filesystem = { ...migrated.filesystem, allowWrite: [...(migrated.filesystem?.allowWrite ?? []), ...paths] };
				try {
					copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.legacy.bak`);
				} catch {
					/* backup is best-effort; the migration itself still applies */
				}
				writeFileSync(CONFIG_PATH, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
				global = migrated;
			} else {
				global = raw as Partial<SandboxConfig>;
			}
		} catch (e) {
			console.error(`sandbox: could not parse ${CONFIG_PATH}: ${e}`);
		}
	}

	if (existsSync(projectPath)) {
		try {
			project = JSON.parse(readFileSync(projectPath, "utf8")) as Partial<SandboxConfig>;
		} catch (e) {
			console.error(`sandbox: could not parse ${projectPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, global), project);
}

function saveConfig(config: SandboxConfig): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});
				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;
	let lastError: string | undefined;
	let activeConfig: SandboxConfig = DEFAULT_CONFIG;
	const bypassReported = new Set<string>();

	/** Commands explicitly configured to run outside the sandbox (documented, reported as a fact). */
	const bypassedCommand = (command: string): string | undefined => {
		if (!sandboxEnabled) return undefined;
		for (const pattern of activeConfig.unsandboxedCommands ?? []) {
			if (pattern && command.includes(pattern)) return pattern;
		}
		return undefined;
	};

	const statusText = () => {
		if (!sandboxEnabled) return lastError ? `🔓 Sandbox off (${lastError})` : "🔓 Sandbox off";
		const cfg = SandboxManager.getConfig();
		const domains = cfg?.network?.allowedDomains?.length ?? 0;
		const writes = cfg?.filesystem?.allowWrite?.length ?? 0;
		return `🔒 Sandbox: ${domains} domains, ${writes} write paths`;
	};

	// Sandboxed bash replaces the built-in tool; when disabled the original runs untouched.
	pi.registerTool({
		...localBash,
		label: sandboxEnabled ? "bash (sandboxed)" : "bash",
		async execute(id, params, signal, onUpdate, ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate, ctx);
			}
			const command = typeof (params as { command?: unknown }).command === "string" ? (params as { command: string }).command : "";
			const bypass = bypassedCommand(command);
			if (bypass) {
				if (!bypassReported.has(bypass)) {
					bypassReported.add(bypass);
					ctx.ui.notify(`sandbox: '${bypass}' ran outside the sandbox (unsandboxedCommands in sandbox.json)`, "warning");
				}
				return localBash.execute(id, params, signal, onUpdate, ctx);
			}
			const sandboxedBash = createBashTool(localCwd, { operations: createSandboxedBashOps() });
			return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("user_bash", (event) => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		const command = typeof (event as { command?: unknown }).command === "string" ? (event as { command: string }).command : "";
		if (bypassedCommand(command)) return; // user ran something on the unsandboxed list
		return { operations: createSandboxedBashOps() };
	});

	async function initialize(config: SandboxConfig): Promise<void> {
		await SandboxManager.initialize({
			network: config.network,
			filesystem: config.filesystem,
			ignoreViolations: config.ignoreViolations,
			enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
		});
		sandboxInitialized = true;
		sandboxEnabled = true;
		lastError = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("no-sandbox") === true) {
			sandboxEnabled = false;
			lastError = "disabled via --no-sandbox";
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}
		const config = loadConfig(ctx.cwd);
		activeConfig = config;
		if (config.enabled === false) {
			sandboxEnabled = false;
			lastError = "disabled via config";
			ctx.ui.notify(`Sandbox disabled via ${CONFIG_PATH}`, "info");
			return;
		}
		if (!SandboxManager.isSupportedPlatform()) {
			sandboxEnabled = false;
			lastError = `unsupported platform ${process.platform}`;
			ctx.ui.notify(`Sandbox not supported on ${process.platform} — bash runs unsandboxed`, "warning");
			return;
		}
		try {
			await initialize(config);
			activeConfig = config;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", statusText()));
		} catch (err) {
			sandboxEnabled = false;
			sandboxInitialized = false;
			lastError = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Sandbox initialization failed: ${lastError}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (!sandboxInitialized) return;
		try {
			await SandboxManager.reset();
		} catch {
			/* cleanup is best-effort */
		}
		sandboxInitialized = false;
	});

	pi.registerCommand("sandbox", {
		description: "OS sandbox: /sandbox [status|on|off|allow-domain <d>|allow-path <p>|violations]",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const config = loadConfig(ctx.cwd);

			const reinit = async (next: SandboxConfig, note: string) => {
				saveConfig(next);
				try {
					await SandboxManager.reset();
				} catch {
					/* re-init below replaces the state */
				}
				sandboxInitialized = false;
				if (next.enabled === false) {
					activeConfig = next;
					sandboxEnabled = false;
					ctx.ui.setStatus("sandbox", undefined);
					ctx.ui.notify(`${note}; sandbox disabled`, "info");
					return;
				}
				await initialize(next);
				activeConfig = next;
				ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", statusText()));
				ctx.ui.notify(`${note}; sandbox re-initialized`, "info");
			};

			switch (cmd) {
				case undefined:
				case "status": {
					const lines = [
						`sandbox: ${sandboxEnabled ? "enabled" : "disabled"}${lastError ? ` (${lastError})` : ""}`,
						`platform supported: ${SandboxManager.isSupportedPlatform()}`,
						`config: ${CONFIG_PATH}`,
						"",
						`network allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
						`network denied:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
						"",
						`denyRead:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
						`allowWrite: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
						`denyWrite:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
						"",
						`run outside the sandbox: ${config.unsandboxedCommands?.join(", ") || "(none)"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "on": {
					await reinit({ ...config, enabled: true }, "enabled");
					return;
				}
				case "off": {
					await reinit({ ...config, enabled: false }, "disabled");
					return;
				}
				case "allow-domain": {
					if (!arg) return ctx.ui.notify("usage: /sandbox allow-domain <domain>", "warning");
					const domains = new Set([...(config.network?.allowedDomains ?? []), arg]);
					await reinit({ ...config, network: { ...config.network, allowedDomains: [...domains] } }, `allowed domain ${arg}`);
					return;
				}
				case "allow-path": {
					if (!arg) return ctx.ui.notify("usage: /sandbox allow-path <path>", "warning");
					const paths = new Set([...(config.filesystem?.allowWrite ?? []), arg]);
					await reinit({ ...config, filesystem: { ...config.filesystem, allowWrite: [...paths] } }, `allowed write path ${arg}`);
					return;
				}
				case "allow-unsandboxed": {
					if (!arg) return ctx.ui.notify("usage: /sandbox allow-unsandboxed <command substring>", "warning");
					const list = new Set([...(config.unsandboxedCommands ?? []), arg]);
					await reinit({ ...config, unsandboxedCommands: [...list] }, `'${arg}' now runs outside the sandbox`);
					return;
				}
				case "deny-unsandboxed": {
					if (!arg) return ctx.ui.notify("usage: /sandbox deny-unsandboxed <command substring>", "warning");
					const list = (config.unsandboxedCommands ?? []).filter((c) => c !== arg);
					await reinit({ ...config, unsandboxedCommands: list }, `'${arg}' removed from the unsandboxed list`);
					return;
				}
				case "violations": {
					const store = SandboxManager.getSandboxViolationStore();
					const items = store.getViolations(20);
					if (items.length === 0) {
						ctx.ui.notify(`no violations recorded (total ${store.getTotalCount()})`, "info");
						return;
					}
					const lines = items.map((v) => {
						const line = String((v as { line?: string }).line ?? JSON.stringify(v)).slice(0, 160);
						return `- ${line}`;
					});
					ctx.ui.notify(`violations (${store.getTotalCount()} total, showing ${items.length}):\n${lines.join("\n")}`, "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown arg '${cmd}'. Use: status | on | off | allow-domain <d> | allow-path <p> | allow-unsandboxed <c> | deny-unsandboxed <c> | violations`, "warning");
			}
		},
	});
}
