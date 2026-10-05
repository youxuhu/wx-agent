/**
 * One workspace = one `pi --mode rpc` child pinned to a directory, plus the extension UI
 * dialogs it is waiting for and the preview dev server started from that directory.
 *
 * The registry in main.ts keeps exactly one of these "active" (the single-writer invariant
 * from PLAN.md §5): only the active workspace accepts prompts and other write commands.
 */
import { realpath } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { PtySession } from "./pty.ts";
import { PiRpcChild, type RpcRecord, type UiRequest } from "./rpc.ts";
import { DevServer, loadPreviewConfig, resolveProject, type PreviewProject } from "./preview.ts";

/** Only these extension UI methods expect an answer; the rest are one-way records. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface WorkspaceHooks {
	record: (record: RpcRecord) => void;
	uiRequest: (request: UiRequest) => void;
	uiResolved: (id: string, response: Record<string, unknown>, reason?: string) => void;
	state: (info: unknown) => void;
	stderr: (chunk: string) => void;
	malformed: (line: string) => void;
	preview: () => void;
	/** Terminal output for this workspace (streamed to every attached client). */
	ptyData: (data: string) => void;
	ptyExit: (exitCode: number, signal?: number) => void;
}

export interface WorkspaceInfo {
	path: string;
	active: boolean;
	exists: boolean;
	state: string;
	sessionPath: string | null;
	pendingUi: number;
	previewState: string;
	previewPort: number | null;
	isRepo: boolean;
}

export class Workspace {
	readonly cwd: string;
	/** A real terminal for this workspace (see server/pty.ts). Owned here so it survives UIs. */
	readonly pty: PtySession;
	/** The pi process. Mutable because `/reload` restarts it in place (same cwd, same session). */
	child: PiRpcChild;
	private readonly childOptions: { cwd: string; piBin: string; piNode?: string; piScript?: string; piArgs: string[] };
	private readonly hooks: WorkspaceHooks;
	readonly devServer: DevServer;
	readonly pendingUi = new Map<string, UiRequest>();
	currentSessionPath: string | null = null;
	/** True between agent_start and agent_settled, so a restart can warn about stopping a live run. */
	agentRunning = false;
	lastStderr = "";
	preview: PreviewProject = {};
	previewRoot: string;
	previewConfigured = false;
	isRepo = false;
	private configLoaded = false;

	constructor(cwd: string, options: { piBin: string; piNode?: string; piScript?: string; piArgs: string[]; agentDir: string; hooks: WorkspaceHooks }) {
		this.cwd = cwd;
		this.previewRoot = cwd;
		this.childOptions = { cwd, piBin: options.piBin, piNode: options.piNode, piScript: options.piScript, piArgs: options.piArgs };
		this.hooks = options.hooks;
		this.child = this.spawnChild();
		this.pty = new PtySession(cwd, {
			data: (data) => options.hooks.ptyData(data),
			exit: (exitCode, signal) => options.hooks.ptyExit(exitCode, signal),
		});
		this.devServer = new DevServer(cwd, {
			onStatus: () => options.hooks.preview(),
			onLog: () => undefined,
		});
		this.loadPreviewConfig(options.agentDir);
		void this.detectRepo();
	}

	/**
	 * Create and wire one pi process.
	 *
	 * Every handler checks that the process is still *this* workspace's process: a replaced child
	 * keeps emitting while it dies, and a late event from it must never be applied to the new one
	 * (same trap as the terminal's callbacks).
	 */
	private spawnChild(): PiRpcChild {
		const hooks = this.hooks;
		const child = new PiRpcChild(this.childOptions);
		child.on("record", (record: RpcRecord) => {
			if (this.child !== child) return;
			this.handleRecord(record, hooks);
		});
		child.on("state", (info: unknown) => {
			if (this.child !== child) return;
			hooks.state(info);
		});
		child.on("stderr", (chunk: string) => {
			if (this.child !== child) return;
			this.lastStderr = `${this.lastStderr}${chunk}`.slice(-4000);
			hooks.stderr(chunk);
		});
		child.on("malformed", (line: string) => {
			if (this.child !== child) return;
			hooks.malformed(line);
		});
		child.start();
		return child;
	}

	/**
	 * Restart pi in place (`/reload`): a new process, same working directory, the same session file
	 * resumed, terminal untouched. Returns the session it asked to resume so the caller can report it.
	 */
	restartChild(): { resumed: string | null; pendingApprovals: number } {
		const resumed = this.currentSessionPath;
		const pendingApprovals = this.pendingUi.size;
		// Requests that were waiting belonged to the process that is going away.
		this.pendingUi.clear();
		const previous = this.child;
		this.child = this.spawnChild();
		previous.stop();
		this.currentSessionPath = resumed;
		if (resumed) this.child.command("switch_session", { sessionPath: resumed });
		return { resumed, pendingApprovals };
	}

	private async detectRepo(): Promise<void> {
		try {
			const { isRepo } = await import("./git.ts");
			this.isRepo = await isRepo(this.cwd);
		} catch {
			this.isRepo = false;
		}
	}

	/** Preview config is per project and read once per workspace. */
	loadPreviewConfig(agentDir: string): void {
		if (this.configLoaded) return;
		this.configLoaded = true;
		void loadPreviewConfig(agentDir)
			.then(async (config) => {
				// Config keys are paths as the user wrote them (/tmp/…) while workspaces are
				// canonical (realpath: /private/tmp/…) — normalize before matching.
				const projects: Record<string, typeof config.projects[string]> = {};
				for (const [key, value] of Object.entries(config.projects)) {
					let canonical = key;
					try {
						canonical = await realpath(key);
					} catch {
						/* keep the key as written when it cannot be resolved */
					}
					projects[canonical] = value;
					projects[key] = value;
				}
				const resolved = resolveProject(this.cwd, { projects });
				this.preview = resolved.project;
				this.previewRoot = resolved.project.root ?? this.cwd;
				this.previewConfigured = Boolean(resolved.project.command);
			})
			.catch(() => undefined);
	}

	private handleRecord(record: RpcRecord, hooks: WorkspaceHooks): void {
		if (record.type === "agent_start") this.agentRunning = true;
		if (record.type === "agent_end" || record.type === "agent_settled") this.agentRunning = false;
		if (record.type === "response") {
			if (record.command === "get_state") {
				const data = record.data as { sessionFile?: string } | undefined;
				if (data?.sessionFile) this.currentSessionPath = data.sessionFile;
			}
			if (record.command === "switch_session") {
				const data = record.data as { cancelled?: boolean; sessionFile?: string } | undefined;
				if (!data?.cancelled && data?.sessionFile) this.currentSessionPath = data.sessionFile;
			}
		}
		if (record.type === "extension_ui_request") {
			const request = record as unknown as UiRequest;
			if (!DIALOG_METHODS.has(request.method)) {
				hooks.record(record); // one-way record: forward, nothing to answer
				return;
			}
			this.pendingUi.set(request.id, request);
			hooks.record(record);
			hooks.uiRequest(request);
			// A dialog with a deadline: on expiry report a cancellation to pi (never an "allow").
			if (typeof request.timeout === "number" && request.timeout > 0) {
				setTimeout(() => {
					if (!this.pendingUi.has(request.id)) return;
					this.pendingUi.delete(request.id);
					this.child.respondUi(request.id, { cancelled: true });
					hooks.uiResolved(request.id, { cancelled: true }, "timeout");
				}, request.timeout);
			}
			return;
		}
		hooks.record(record);
	}

	answer(id: string, response: Record<string, unknown>): boolean {
		if (!this.pendingUi.has(id)) return false;
		this.pendingUi.delete(id);
		this.child.respondUi(id, response);
		return true;
	}

	getPreviewStatus(): ReturnType<DevServer["getStatus"]> {
		return this.devServer.getStatus();
	}

	info(active: boolean): WorkspaceInfo {
		const status = this.devServer.getStatus();
		return {
			path: this.cwd,
			active,
			exists: true,
			state: this.child.getState(),
			sessionPath: this.currentSessionPath,
			pendingUi: this.pendingUi.size,
			previewState: status.state,
			previewPort: status.port,
			isRepo: this.isRepo,
		};
	}

	dispose(): void {
		this.devServer.dispose();
		this.child.stop();
		this.pty.dispose();
	}
}

/** Resolve a directory into a canonical workspace key (symlinks collapsed). */
export async function workspaceKey(path: string): Promise<string> {
	const real = await realpath(path);
	const info = await stat(real);
	if (!info.isDirectory()) throw new Error(`not a directory: ${path}`);
	return real;
}
