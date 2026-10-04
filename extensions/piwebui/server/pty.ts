/**
 * A real terminal for one workspace: one PTY-backed shell process per workspace.
 *
 * This is deliberately *not* pi's `bash` command. That command is stateless — every call is a new
 * shell in the workspace directory, so `cd` cannot survive and `clear` cannot work (it needs a
 * terminal). A PTY gives the shell a terminal of its own, which is what makes `cd`, `export`,
 * aliases, `clear`, colors and full-screen programs behave the way they do in a terminal emulator.
 * The cost is that what runs here is not part of the model's context, so the UI offers to insert
 * the screen into a prompt instead of pretending otherwise.
 *
 * The session outlives the browser drawer (like a terminal in an editor survives a panel toggle),
 * so a bounded replay buffer lets a reattaching client see the recent history.
 */
import { spawn, type IPty } from "node-pty";

/** How much output a reattaching client gets back (bounded, and the drop is reported). */
const REPLAY_LIMIT = 256 * 1024;

export interface PtyHooks {
	data(data: string): void;
	exit(exitCode: number, signal?: number): void;
}

export interface PtyState {
	running: boolean;
	cols: number;
	rows: number;
	/** Recent output for a client that just (re)attached. */
	replay: string;
	/** Characters dropped from the replay buffer (stated, never silent). */
	droppedChars: number;
	shell: string;
}


export class PtySession {
	private pty: IPty | null = null;
	private replay = "";
	private droppedChars = 0;
	private cols = 100;
	private rows = 30;

	// Explicit fields: Node's strip-only TypeScript mode does not support parameter properties.
	readonly cwd: string;
	private readonly hooks: PtyHooks;

	constructor(cwd: string, hooks: PtyHooks) {
		this.cwd = cwd;
		this.hooks = hooks;
	}

	private get shell(): string {
		return process.env.SHELL ?? "/bin/bash";
	}

	/**
	 * Start the shell, or report the running one. `cwd` is the workspace: the terminal is not a way
	 * around the single-writer rule, it is a shell inside the folder the workspace owns.
	 */
	start(cols = this.cols, rows = this.rows): PtyState {
		if (!this.pty) {
			this.cols = cols;
			this.rows = rows;
			const child = spawn(this.shell, ["-l"], {
				name: "xterm-256color",
				cols,
				rows,
				cwd: this.cwd,
				env: {
					...process.env,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					// Tell tools they are on a terminal, which is the point of this session.
					PIWEBUI_TERMINAL: "1",
				},
			});
			this.pty = child;
			// Every callback checks that it still belongs to the *current* child. A killed shell exits
			// asynchronously, so without this guard the old exit clears the reference to the shell that
			// replaced it — leaving a live but untracked terminal (typing silently refused).
			child.onData((data) => {
				if (this.pty !== child) return;
				this.appendReplay(data);
				this.hooks.data(data);
			});
			child.onExit(({ exitCode, signal }) => {
				if (this.pty !== child) return;
				this.pty = null;
				this.hooks.exit(exitCode, signal);
			});
			// An unhandled "error" event on an EventEmitter throws, and a throw here is a dead service.
			(child as unknown as { on(event: string, handler: (error: unknown) => void): void }).on("error", (error) => {
				if (this.pty !== child) return;
				this.pty = null;
				this.hooks.exit(1, undefined);
				this.hooks.data(`\r\n[terminal error] ${String(error)}\r\n`);
			});
		} else if (cols !== this.cols || rows !== this.rows) {
			this.resize(cols, rows);
		}
		return this.state();
	}

	state(): PtyState {
		return {
			running: this.pty !== null,
			cols: this.cols,
			rows: this.rows,
			replay: this.replay,
			droppedChars: this.droppedChars,
			shell: this.shell,
		};
	}

	write(data: string): boolean {
		if (!this.pty) return false;
		this.pty.write(data);
		return true;
	}

	resize(cols: number, rows: number): boolean {
		this.cols = Math.max(1, Math.floor(cols));
		this.rows = Math.max(1, Math.floor(rows));
		if (!this.pty) return false;
		try {
			this.pty.resize(this.cols, this.rows);
			return true;
		} catch {
			// A resize can race with the exit of the shell; the next start() will pick the size up.
			return false;
		}
	}

	/**
	 * Replace the shell with a fresh one: kill, forget the history of the old one, start again.
	 * The old child's exit arrives later and is ignored by the identity guard above, so there is no
	 * window in which the session points at a shell nobody owns.
	 */
	restart(cols = this.cols, rows = this.rows): PtyState {
		this.kill();
		this.replay = "";
		this.droppedChars = 0;
		return this.start(cols, rows);
	}

	kill(): void {
		const child = this.pty;
		this.pty = null;
		if (!child) return;
		try {
			child.kill();
		} catch {
			// already gone
		}
	}

	dispose(): void {
		this.kill();
		this.replay = "";
	}

	private appendReplay(data: string): void {
		const combined = this.replay + data;
		if (combined.length <= REPLAY_LIMIT) {
			this.replay = combined;
			return;
		}
		this.droppedChars += combined.length - REPLAY_LIMIT;
		this.replay = combined.slice(-REPLAY_LIMIT);
	}
}
