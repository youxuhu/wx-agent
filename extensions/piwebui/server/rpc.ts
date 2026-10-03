/**
 * PiRpcChild — a supervised `pi --mode rpc` child process.
 *
 * Protocol (see the pi install docs `docs/rpc.md`):
 *   - stdin: one JSON command per line, LF terminated.
 *   - stdout: JSONL records only (responses + session events + extension UI requests).
 *   - stderr: diagnostics.
 *
 * Framing rules this implements:
 *   - split records on LF only (never on U+2028/U+2029, so no `readline`),
 *   - strip a trailing CR,
 *   - keep reading stdout (a client that stops reading stalls pi).
 *
 * Invariants (see PLAN.md §5):
 *   - a crashed child is reported, never silently replaced, and pending work is
 *     never replayed automatically,
 *   - an unanswered extension UI dialog stays pending (pi's own semantics: no
 *     timeout field means it waits), and we never auto-answer as "allow".
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type UiMethod = "select" | "confirm" | "input" | "editor";

export interface UiRequest {
	type: "extension_ui_request";
	id: string;
	method: UiMethod;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	timeout?: number;
}

export interface RpcRecord {
	type: string;
	id?: string;
	[key: string]: unknown;
}

export interface PiRpcOptions {
	piBin?: string;
	args?: string[];
	cwd: string;
}

export type PiRpcState = "stopped" | "starting" | "running" | "exited" | "failed";

export class PiRpcChild extends EventEmitter {
	readonly options: PiRpcOptions;
	private child: ChildProcessWithoutNullStreams | null = null;
	private stdoutBuffer = "";
	private state: PiRpcState = "stopped";
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null; at: string } | null = null;

	constructor(options: PiRpcOptions) {
		super();
		this.options = options;
	}

	getState(): PiRpcState {
		return this.state;
	}

	getExitInfo() {
		return this.exitInfo;
	}

	/** Start the child. Does nothing when it is already running. */
	start(): void {
		if (this.child) return;
		this.state = "starting";
		const bin = this.options.piBin ?? "pi";
		const args = this.options.args ?? ["--mode", "rpc"];
		const child = spawn(bin, args, {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_WEB_UI: "1" },
		});
		this.child = child;
		this.exitInfo = null;

		child.on("spawn", () => {
			this.state = "running";
			this.emit("state", { state: this.state });
		});
		child.on("error", (error) => {
			this.state = "failed";
			this.exitInfo = { code: null, signal: null, at: new Date().toISOString() };
			this.emit("state", { state: this.state, error: String(error) });
			this.child = null;
		});
		child.on("exit", (code, signal) => {
			this.state = code === 0 ? "exited" : "failed";
			this.exitInfo = { code, signal, at: new Date().toISOString() };
			this.emit("state", { state: this.state, code, signal });
			this.child = null;
			this.stdoutBuffer = "";
		});

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consume(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
	}

	private consume(chunk: string): void {
		this.stdoutBuffer += chunk;
		let nl = this.stdoutBuffer.indexOf("\n");
		while (nl !== -1) {
			let line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) {
				try {
					this.emit("record", JSON.parse(line) as RpcRecord);
				} catch {
					this.emit("malformed", line);
				}
			}
			nl = this.stdoutBuffer.indexOf("\n");
		}
	}

	/** Write one command record. Returns false when the child is not writable. */
	send(command: Record<string, unknown>): boolean {
		if (!this.child || !this.child.stdin.writable) return false;
		return this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	prompt(message: string, id = `prompt-${Date.now()}`): boolean {
		return this.send({ id, type: "prompt", message });
	}

	command(type: string, payload: Record<string, unknown> = {}): boolean {
		return this.send({ id: `${type}-${Date.now()}`, type, ...payload });
	}

	/** Answer an extension UI dialog. `cancelled` maps to a dismissed dialog. */
	respondUi(id: string, response: Record<string, unknown>): boolean {
		return this.send({ type: "extension_ui_response", id, ...response });
	}

	stop(): void {
		const child = this.child;
		if (!child) return;
		this.child = null;
		this.state = "stopped";
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
		child.once("exit", () => clearTimeout(timer));
	}
}
