/**
 * pi web ui — local Node service.
 *
 * Binds loopback only, serves the built single-page app from `dist/`, and bridges a WebSocket
 * to one or more supervised `pi --mode rpc` children — one child per workspace (directory).
 * The browser never talks to pi directly: approvals, state and events all pass through here so
 * the invariants in PLAN.md §5 can be enforced in one place.
 *
 * Usage: node server/main.ts [--port 7799] [--cwd <dir>] [--pi <bin>] [--model <id>]
 *        [--pi-node <node> --pi-script <cli.js>]   # packaged builds without a `pi` command
 *        [--agent-dir <dir>] [--web-dir <dir>]     # web-dir: built UI, default sibling `dist/`
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { readFile as readJsonFile, writeFile as writeJsonFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { PiRpcChild, type RpcRecord, type UiRequest } from "./rpc.ts";
import { deleteSession, isSessionPathOf, listSessions } from "./sessions.ts";
import { FILE_PREFIX, PROXY_PREFIX, filePreview, proxyRequest } from "./preview.ts";
import { Workspace, workspaceKey } from "./workspace.ts";
import { browse, listDir, readText } from "./fs.ts";
import { listAuth, removeProvider, setApiKey } from "./auth.ts";
import * as git from "./git.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
/** Where the built UI lives; a desktop shell overrides it with `--web-dir`. */
let distDir = join(projectRoot, "dist");

interface Args {
	port: number;
	host: string;
	/** Optional: without it the service starts with no workspace (see the startup block). */
	cwd?: string;
	piBin: string;
	/** Optional node binary + script pair, for builds without a `pi` command on PATH. */
	piNode?: string;
	piScript?: string;
	agentDir?: string;
	webDir?: string;
	model?: string;
	thinking?: string;
	/** Do not persist the active folder (probes and scratch instances must not clobber it). */
	noRemember?: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { port: 7799, host: "127.0.0.1", piBin: "pi" };
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		const value = argv[i + 1];
		if (key === "--port" && value) args.port = Number(value);
		else if (key === "--host" && value) args.host = value;
		else if (key === "--cwd" && value) args.cwd = resolve(value);
		else if (key === "--pi" && value) args.piBin = value;
		else if (key === "--pi-node" && value) args.piNode = value;
		else if (key === "--pi-script" && value) args.piScript = value;
		else if (key === "--agent-dir" && value) args.agentDir = resolve(value);
		else if (key === "--web-dir" && value) args.webDir = resolve(value);
		else if (key === "--model" && value) args.model = value;
		else if (key === "--thinking" && value) args.thinking = value;
		else if (key === "--no-remember") args.noRemember = true;
	}
	return args;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json; charset=utf-8",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	// no directory traversal: resolve inside dist and verify
	const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
	let filePath = resolve(distDir, relative || "index.html");
	if (!filePath.startsWith(distDir)) {
		res.writeHead(403).end("forbidden");
		return;
	}
	try {
		const info = await stat(filePath);
		if (info.isDirectory()) filePath = join(filePath, "index.html");
	} catch {
		filePath = join(distDir, "index.html"); // SPA fallback
	}
	try {
		const body = await readFile(filePath);
		res.writeHead(200, {
			"content-type": MIME[extname(filePath)] ?? "application/octet-stream",
			"cache-control": "no-cache",
		});
		res.end(body);
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end(`not found: ${pathname}\n(the UI is not built yet — run: npm run build)`);
	}
}

/**
 * RPC commands the browser may trigger. Field names follow docs/rpc-commands.md; anything
 * not listed here is refused instead of being forwarded blindly.
 */
const RPC_PASSTHROUGH: Record<string, { fields: string[]; required?: string[]; write?: boolean }> = {
	get_commands: { fields: [] },
	get_available_models: { fields: [] },
	get_available_thinking_levels: { fields: [] },
	get_session_stats: { fields: [] },
	get_tree: { fields: [] },
	get_entries: { fields: ["since"] },
	get_fork_messages: { fields: [] },
	get_last_assistant_text: { fields: [] },
	cycle_model: { fields: [], write: true },
	cycle_thinking_level: { fields: [], write: true },
	abort_retry: { fields: [], write: true },
	abort_bash: { fields: [], write: true },
	clone: { fields: [], write: true },
	set_model: { fields: ["provider", "modelId"], required: ["modelId"], write: true },
	set_thinking_level: { fields: ["level"], required: ["level"], write: true },
	set_auto_compaction: { fields: ["enabled"], required: ["enabled"], write: true },
	set_auto_retry: { fields: ["enabled"], required: ["enabled"], write: true },
	set_steering_mode: { fields: ["mode"], required: ["mode"], write: true },
	set_follow_up_mode: { fields: ["mode"], required: ["mode"], write: true },
	fork: { fields: ["entryId"], required: ["entryId"], write: true },
	export_html: { fields: ["outputPath"], write: true },
	bash: { fields: ["command", "excludeFromContext"], required: ["command"], write: true },
};

/** Commands reachable through `prompt` that change state (everything else is read-only). */
const WRITE_TYPES = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"clear_queue",
	"new_session",
	"switch_session",
	"set_session_name",
	"compact",
	"dev_start",
	"dev_stop",
]);

/**
 * Config files the web UI may read and write. Credentials (auth.json), caches and
 * dependency manifests are deliberately excluded.
 */
const CONFIG_FILES = [
	"settings.json",
	"models.json",
	"policy.json",
	"sandbox.json",
	"notify.json",
	"computer-use.json",
	"checkpoints.json",
	"preview.json",
	"trust.json",
];

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((done, fail) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > MAX_BODY) {
				fail(new Error(`body larger than ${MAX_BODY} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
		req.on("error", fail);
	});
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (args.webDir) distDir = args.webDir;
	// Sessions live next to the config that pi itself uses (PI_CODING_AGENT_DIR wins).
	const agentDir = args.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

	// Invariant: loopback only. A non-loopback host would expose the session to the network.
	const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
	if (!loopback.has(args.host)) {
		console.error(`refusing to bind ${args.host}: only loopback hosts are allowed (use an ssh -L tunnel for remote access)`);
		process.exit(2);
	}

	const piArgs = ["--mode", "rpc"];
	if (args.model) piArgs.push("--model", args.model);
	if (args.thinking) piArgs.push("--thinking", args.thinking);

	/** Workspace registry, keyed by canonical (realpath) directory. */
	const workspaces = new Map<string, Workspace>();
	/** The one workspace allowed to accept write commands (single writer). */
	let activeKey: string | null = null;
	/** Recently opened directories, newest first. */
	let recent: string[] = [];

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://${args.host}:${args.port}`);
		/** Workspace for this request: explicit `?ws=` (canonical path) or the active one. */
		const wsFor = (): Workspace | null => {
			const requested = url.searchParams.get("ws");
			if (requested) return workspaces.get(requested) ?? null;
			return activeKey ? (workspaces.get(activeKey) ?? null) : null;
		};
		const fail = (code: number, message: string): void => {
			if (res.headersSent) {
				res.end();
				return;
			}
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: message }));
		};

		if (url.pathname === "/api/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					active: activeKey,
					workspaces: [...workspaces.values()].map((workspace) => workspace.info(workspace.cwd === activeKey)),
				}),
			);
			return;
		}

		if (url.pathname === "/api/workspaces") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					active: activeKey,
					recent,
					workspaces: [...workspaces.values()].map((workspace) => workspace.info(workspace.cwd === activeKey)),
				}),
			);
			return;
		}

		if (url.pathname === "/api/fs") {
			void browse(url.searchParams.get("path"))
				.then((result) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(result));
				})
				.catch((error: unknown) => fail(500, String(error)));
			return;
		}

		if (url.pathname === "/api/tree") {
			const workspace = wsFor();
			if (!workspace) return fail(409, `no workspace is active yet`);
			const requestedDir = url.searchParams.get("dir");
			const dir = requestedDir && requestedDir.trim() ? requestedDir : workspace.cwd;
			const showIgnored = url.searchParams.get("showIgnored") === "1";
			void listDir(workspace.cwd, dir, { showIgnored })
				.then((entries) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ dir, root: workspace.cwd, entries }));
				})
				.catch((error: unknown) => fail(403, String(error)));
			return;
		}

		if (url.pathname === "/api/file") {
			const workspace = wsFor();
			if (!workspace) return fail(409, `no workspace is active yet`);
			const path = url.searchParams.get("path") ?? "";
			void readText(workspace.cwd, path)
				.then((result) => {
					if (typeof result === "string") {
						fail(403, result);
						return;
					}
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(result));
				})
				.catch((error: unknown) => fail(500, String(error)));
			return;
		}

		if (url.pathname.startsWith("/api/git/")) {
			const workspace = wsFor();
			if (!workspace) return fail(409, `no workspace is active yet`);
			const root = workspace.cwd;
			const action = url.pathname.slice("/api/git/".length);
			if (req.method === "POST") {
				// Git writes: argv is composed in server/git.ts, never by the browser.
				void (async (): Promise<void> => {
					let body: { paths?: string[]; message?: string; amend?: boolean; confirmed?: boolean; branch?: string; name?: string };
					try {
						body = JSON.parse((await readBody(req)) || "{}") as typeof body;
					} catch (error) {
						return fail(400, `unreadable body: ${String(error)}`);
					}
					const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
					let result: git.ActionOutcome;
					switch (action) {
						case "stage":
							result = await git.stage(root, paths);
							break;
						case "unstage":
							result = await git.unstage(root, paths);
							break;
						case "discard":
							result = await git.discard(root, paths, body.confirmed === true);
							break;
						case "commit":
							result = await git.commit(root, String(body.message ?? ""), body.amend === true);
							break;
						case "checkout":
							result = await git.checkout(root, String(body.branch ?? ""));
							break;
						case "branch":
							result = await git.createBranch(root, String(body.name ?? ""));
							break;
						default:
							return fail(404, `unknown git action: ${action}`);
					}
					res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
					res.end(JSON.stringify(result));
				})().catch((error: unknown) => fail(500, String(error)));
				return;
			}
			void (async (): Promise<void> => {
				switch (action) {
					case "status": {
						const data = await git.status(root);
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify(data));
						return;
					}
					case "diff": {
						const options = {
							path: url.searchParams.get("path") ?? undefined,
							staged: url.searchParams.get("staged") === "1",
							ref: url.searchParams.get("ref") ?? undefined,
						};
						const result = await git.diff(root, options);
						res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
						res.end(JSON.stringify(result));
						return;
					}
					case "numstat": {
						const data = await git.numstat(root, url.searchParams.get("staged") === "1");
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify(data));
						return;
					}
					case "branches": {
						const data = await git.branches(root);
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ branches: data }));
						return;
					}
					case "log": {
						const limit = Number(url.searchParams.get("limit") ?? 100);
						const commits = await git.log(root, { limit, ref: url.searchParams.get("ref") ?? undefined, path: url.searchParams.get("path") ?? undefined });
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ commits }));
						return;
					}
					case "stash": {
						const stash = await git.stashList(root);
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ stash }));
						return;
					}
					case "show": {
						const ref = url.searchParams.get("ref") ?? "";
						const patch = url.searchParams.get("patch") !== "0";
						const result = await git.show(root, ref, patch);
						res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
						res.end(JSON.stringify(result));
						return;
					}
					default:
						fail(404, `unknown git action: ${action}`);
						return;
				}
			})().catch((error: unknown) => fail(500, String(error)));
			return;
		}

		if (url.pathname === "/api/sessions") {
			const workspace = wsFor();
			if (!workspace) return fail(409, "no workspace is active yet");
			void listSessions(workspace.cwd, agentDir)
				.then((items) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ items, current: workspace.currentSessionPath, cwd: workspace.cwd }));
				})
				.catch((error: unknown) => fail(500, String(error)));
			return;
		}

		if (url.pathname === "/api/auth" && req.method === "GET") {
			void listAuth(agentDir)
				.then((snapshot) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(snapshot));
				})
				.catch((error: unknown) => fail(500, String(error)));
			return;
		}
		if (url.pathname === "/api/auth" && req.method === "PUT") {
			void (async () => {
				let body: { provider?: string; key?: string };
				try {
					body = JSON.parse((await readBody(req)) || "{}") as typeof body;
				} catch (error) {
					return fail(400, `unreadable body: ${String(error)}`);
				}
				const result = await setApiKey(agentDir, String(body.provider ?? ""), String(body.key ?? ""));
				res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
				res.end(JSON.stringify(result));
			})().catch((error: unknown) => fail(500, String(error)));
			return;
		}
		if (url.pathname === "/api/auth" && req.method === "DELETE") {
			void (async () => {
				const provider = url.searchParams.get("provider") ?? "";
				const confirmed = url.searchParams.get("confirmed") === "1";
				const result = await removeProvider(agentDir, provider, confirmed);
				res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
				res.end(JSON.stringify(result));
			})().catch((error: unknown) => fail(500, String(error)));
			return;
		}
		if (url.pathname === "/api/config" && req.method === "GET") {
			void (async () => {
				const files = [];
				for (const name of CONFIG_FILES) {
					const path = join(agentDir, name);
					try {
						const [info, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
						files.push({ name, path, exists: true, bytes: info.size, content });
					} catch (error) {
						files.push({ name, path, exists: false, bytes: 0, content: "", error: (error as NodeJS.ErrnoException).code ?? String(error) });
					}
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ agentDir, files, note: "auth.json is not exposed" }));
			})().catch((error: unknown) => fail(500, String(error)));
			return;
		}

		if (url.pathname === "/api/config" && req.method === "PUT") {
			void (async () => {
				let body: { name?: string; content?: string };
				try {
					body = JSON.parse(await readBody(req)) as { name?: string; content?: string };
				} catch (error) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: `unreadable body: ${String(error)}` }));
					return;
				}
				const name = String(body.name ?? "");
				// Invariant: only the allowlisted names may be written (no traversal, no auth.json).
				if (!CONFIG_FILES.includes(name)) {
					res.writeHead(403, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: `refused: ${name || "(empty)"} is not one of ${CONFIG_FILES.join(", ")}` }));
					return;
				}
				const content = String(body.content ?? "");
				try {
					JSON.parse(content);
				} catch (error) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: `refused: not valid JSON — ${String(error)}` }));
					return;
				}
				const path = join(agentDir, name);
				const previous = await readFile(path, "utf8").catch(() => null);
				if (previous !== null) await writeFile(`${path}.bak`, previous, "utf8");
				const tmp = `${path}.tmp-${process.pid}`;
				await writeFile(tmp, content, "utf8");
				await rename(tmp, path);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						ok: true,
						name,
						path,
						bytes: Buffer.byteLength(content),
						backupPath: previous !== null ? `${path}.bak` : null,
						takesEffect: "written to disk; extensions read their config when the session loads — /reload in the terminal (or a restart) applies it",
					}),
				);
			})().catch((error: unknown) => fail(500, String(error)));
			return;
		}

		if (url.pathname === "/api/preview") {
			const workspace = wsFor();
			if (!workspace) return fail(409, "no workspace is active yet");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(previewInfo(workspace)));
			return;
		}

		if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
			const workspace = wsFor();
			const status = workspace?.getPreviewStatus() ?? null;
			// Invariant: one pinned loopback upstream (the dev server); no arbitrary targets.
			if (!status?.port) {
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end(`refused: no local dev server upstream (${status ? `state ${status.state}${status.error ? `, ${status.error}` : ""}` : "no workspace"}) — start it first, or the configured port is unknown`);
				return;
			}
			void proxyRequest(req, res, { upstreamHost: "127.0.0.1", upstreamPort: status.port, pathname: url.pathname, search: url.search });
			return;
		}

		if (url.pathname === FILE_PREFIX || url.pathname.startsWith(`${FILE_PREFIX}/`)) {
			const workspace = wsFor();
			if (!workspace) return fail(409, "no workspace is active yet");
			const requested = url.searchParams.get("path") ?? decodeURIComponent(url.pathname.slice(FILE_PREFIX.length));
			void filePreview(res, workspace.previewRoot, requested);
			return;
		}

		void serveStatic(url.pathname, res);
	});

	const wss = new WebSocketServer({ server, path: "/ws" });

	const broadcast = (message: unknown, workspace?: Workspace | null): void => {
		const payload = JSON.stringify(workspace ? { ...(message as object), workspace: workspace.cwd } : message);
		for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
	};

	const previewInfo = (workspace: Workspace): Record<string, unknown> => ({
		type: "preview",
		workspace: workspace.cwd,
		status: workspace.getPreviewStatus(),
		project: {
			command: workspace.preview.command ?? null,
			port: workspace.preview.port ?? null,
			readyPattern: workspace.preview.readyPattern ?? null,
			configured: workspace.previewConfigured,
		},
		proxyPrefix: PROXY_PREFIX,
		filePrefix: FILE_PREFIX,
	});

	/** Create (or reuse) the workspace for a directory. */
	const ensureWorkspace = async (path: string): Promise<Workspace | string> => {
		let key: string;
		try {
			key = await workspaceKey(path);
		} catch (error) {
			return `refused: ${String(error)}`;
		}
		const existing = workspaces.get(key);
		if (existing) return existing;
		const hooks = {
			record: (record: RpcRecord): void => broadcast({ type: "record", record }, workspaceByCwd(key)),
			uiRequest: (request: UiRequest): void => broadcast({ type: "ui_request", request }, workspaceByCwd(key)),
			uiResolved: (id: string, response: Record<string, unknown>, reason?: string): void =>
				broadcast({ type: "ui_resolved", id, response, reason }, workspaceByCwd(key)),
			state: (info: unknown): void => broadcast({ type: "pi_state", ...(info as object) }, workspaceByCwd(key)),
			stderr: (chunk: string): void => broadcast({ type: "pi_stderr", chunk: chunk.slice(-2000) }, workspaceByCwd(key)),
			ptyData: (data: string): void => broadcast({ type: "pty_data", workspace: key, data }, workspaceByCwd(key)),
			ptyExit: (exitCode: number, signal?: number): void => broadcast({ type: "pty_exit", workspace: key, exitCode, signal }, workspaceByCwd(key)),
			malformed: (line: string): void => broadcast({ type: "malformed", line: line.slice(0, 500) }, workspaceByCwd(key)),
			preview: (): void => {
				const workspace = workspaceByCwd(key);
				if (workspace) broadcast(previewInfo(workspace), workspace);
			},
		};
		const workspace = new Workspace(key, { piBin: args.piBin, piNode: args.piNode, piScript: args.piScript, piArgs, agentDir, hooks });
		workspaces.set(key, workspace);
		recent = [key, ...recent.filter((item) => item !== key)].slice(0, 20);
		saveRecent();
		broadcastWorkspaces();
		return workspace;
	};

	const workspaceByCwd = (cwd: string): Workspace | null => workspaces.get(cwd) ?? null;

	/** Read-only commands may target any workspace; writes only the active one. */
	const resolve = (message: Record<string, unknown>, socket: WebSocket, write: boolean): Workspace | null => {
		const requested = typeof message.workspace === "string" && message.workspace ? message.workspace : activeKey;
		if (!requested) {
			socket.send(JSON.stringify({ type: "error", message: "no workspace is open yet" }));
			return null;
		}
		const workspace = workspaces.get(requested);
		if (!workspace) {
			socket.send(JSON.stringify({ type: "error", message: `unknown workspace: ${requested}` }));
			return null;
		}
		if (write && workspace.cwd !== activeKey) {
			socket.send(
				JSON.stringify({
					type: "error",
					message: `refused: ${workspace.cwd} is not the active workspace (active: ${activeKey ?? "none"}) — switch_workspace first (one writer at a time)`,
				}),
			);
			return null;
		}
		return workspace;
	};

	const workspacesPayload = (): Record<string, unknown> => ({
		type: "workspaces",
		active: activeKey,
		recent,
		workspaces: [...workspaces.values()].map((workspace) => workspace.info(workspace.cwd === activeKey)),
	});

	const broadcastWorkspaces = (): void => broadcast(workspacesPayload());

	/** The folder that was active when this agent dir was last written (see saveRecent). */
	function rememberedWorkspace(dir: string): string | null {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, "piwebui-workspaces.json"), "utf8")) as { active?: unknown };
			return typeof parsed.active === "string" && parsed.active ? parsed.active : null;
		} catch {
			return null;
		}
	}

	async function saveRecent(): Promise<void> {
		// A scratch instance (`--no-remember`) must not overwrite the folder a real user last used.
		if (args.noRemember) return;
		try {
			await writeJsonFile(join(agentDir, "piwebui-workspaces.json"), JSON.stringify({ recent, active: activeKey }, null, 2), "utf8");
		} catch {
			/* persisting the recent list is best-effort */
		}
	}

	async function loadRecent(): Promise<void> {
		try {
			const raw = await readJsonFile(join(agentDir, "piwebui-workspaces.json"), "utf8");
			const parsed = JSON.parse(raw) as { recent?: string[] };
			recent = (parsed.recent ?? []).filter((item) => typeof item === "string").slice(0, 20);
		} catch {
			recent = [];
		}
	}

	wss.on("connection", (socket: WebSocket) => {
		const workspace = activeKey ? workspaces.get(activeKey) : undefined;
		socket.send(
			JSON.stringify({
				type: "hello",
				active: activeKey,
				workspaces: [...workspaces.values()].map((item) => item.info(item.cwd === activeKey)),
				recent,
				cwd: workspace?.cwd ?? null,
				state: workspace?.child.getState() ?? "stopped",
				currentSessionPath: workspace?.currentSessionPath ?? null,
				exitInfo: workspace?.child.getExitInfo() ?? null,
				pendingUi: workspace ? [...workspace.pendingUi.values()] : [],
			}),
		);

		socket.on("message", (raw) => {
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(raw));
			} catch {
				socket.send(JSON.stringify({ type: "error", message: "malformed client message" }));
				return;
			}
			handleClientMessage(socket, message);
		});
	});

	function handleClientMessage(socket: WebSocket, message: Record<string, unknown>): void {
		const type = String(message.type ?? "");

		// --- workspace management -------------------------------------------------
		switch (type) {
			case "list_workspaces":
				socket.send(JSON.stringify(workspacesPayload()));
				return;
			case "open_workspace": {
				const path = String(message.path ?? "");
				void ensureWorkspace(path)
					.then((result) => {
						if (typeof result === "string") {
							socket.send(JSON.stringify({ type: "error", message: result }));
							return;
						}
						if (message.activate !== false) {
							activeKey = result.cwd;
							void saveRecent();
						}
						broadcastWorkspaces();
					})
					.catch((error: unknown) => socket.send(JSON.stringify({ type: "error", message: String(error) })));
				return;
			}
			case "switch_workspace": {
				const path = String(message.path ?? "");
				void ensureWorkspace(path)
					.then((result) => {
						if (typeof result === "string") {
							socket.send(JSON.stringify({ type: "error", message: result }));
							return;
						}
						activeKey = result.cwd;
						void saveRecent();
						// pending dialogs of the workspace being left are still there; say so.
						broadcast({ type: "notice", message: `active workspace is now ${result.cwd}${result.pendingUi.size ? ` (${result.pendingUi.size} unresolved dialog(s) remain here)` : ""}`, workspace: result.cwd });
						broadcastWorkspaces();
					})
					.catch((error: unknown) => socket.send(JSON.stringify({ type: "error", message: String(error) })));
				return;
			}
			case "close_workspace": {
				const path = String(message.path ?? "");
				const workspace = workspaces.get(path);
				if (!workspace) {
					socket.send(JSON.stringify({ type: "error", message: `unknown workspace: ${path}` }));
					return;
				}
				workspace.dispose();
				workspaces.delete(path);
				recent = recent.filter((item) => item !== path);
				if (activeKey === path) activeKey = [...workspaces.keys()][0] ?? null;
				void saveRecent();
				broadcastWorkspaces();
				return;
			}
		}

		// --- per-workspace commands ----------------------------------------------
		if (type === "ui_response") {
			const requested = typeof message.workspace === "string" && message.workspace ? message.workspace : activeKey;
			const workspace = requested ? workspaces.get(requested) : undefined;
			const id = String(message.id ?? "");
			if (!workspace) {
				socket.send(JSON.stringify({ type: "error", message: `no workspace for dialog ${id}` }));
				return;
			}
			if (!workspace.pendingUi.has(id)) {
				socket.send(JSON.stringify({ type: "error", message: `unknown or already answered dialog: ${id}` }));
				return;
			}
			// Only forward explicit answers. A dismissed dialog says so.
			const response: Record<string, unknown> =
				message.cancelled === true
					? { cancelled: true }
					: message.confirmed !== undefined
						? { confirmed: Boolean(message.confirmed) }
						: { value: message.value ?? undefined };
			workspace.answer(id, response);
			broadcast({ type: "ui_resolved", id, response }, workspace);
			return;
		}

		const spec = RPC_PASSTHROUGH[type];
		if (spec) {
			const workspace = resolve(message, socket, Boolean(spec.write));
			if (!workspace) return;
			const payload: Record<string, unknown> = {};
			for (const field of spec.fields) if (message[field] !== undefined) payload[field] = message[field];
			const missing = (spec.required ?? []).filter((field) => payload[field] === undefined);
			if (missing.length) {
				socket.send(JSON.stringify({ type: "error", message: `${type} needs ${missing.join(", ")}` }));
				return;
			}
			workspace.child.command(type, payload, typeof message.id === "string" ? message.id : undefined);
			return;
		}

		switch (type) {
			case "prompt": {
				const text = String(message.message ?? "");
				if (!text.trim()) return;
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				const behavior = message.streamingBehavior === "steer" || message.streamingBehavior === "followUp" ? message.streamingBehavior : undefined;
				if (!workspace.child.prompt(text, behavior)) socket.send(JSON.stringify({ type: "error", message: "pi rpc child is not running" }));
				return;
			}
			case "abort": {
				const workspace = resolve(message, socket, true);
				workspace?.child.command("abort");
				return;
			}
			case "steer": {
				const workspace = resolve(message, socket, true);
				workspace?.child.command("steer", { message: String(message.message ?? "") });
				return;
			}
			case "new_session": {
				const workspace = resolve(message, socket, true);
				workspace?.child.command("new_session");
				return;
			}
			case "get_state": {
				const workspace = resolve(message, socket, false);
				workspace?.child.command("get_state");
				return;
			}
			case "get_messages": {
				const workspace = resolve(message, socket, false);
				workspace?.child.command("get_messages");
				return;
			}
			case "list_sessions": {
				const workspace = resolve(message, socket, false);
				if (!workspace) return;
				void listSessions(workspace.cwd, agentDir)
					.then((items) => socket.send(JSON.stringify({ type: "sessions", items, current: workspace.currentSessionPath, workspace: workspace.cwd })))
					.catch((error: unknown) => socket.send(JSON.stringify({ type: "error", message: `list_sessions failed: ${String(error)}` })));
				return;
			}
			case "switch_session": {
				const path = String(message.path ?? "");
				if (!path) {
					broadcast({ type: "error", message: "switch_session needs a path" });
					return;
				}
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				// Invariant: only session files of this workspace's session directory may be loaded.
				void isSessionPathOf(workspace.cwd, agentDir, path).then((ok) => {
					if (!ok) {
						broadcast({ type: "error", message: `refused: not a session file of ${workspace.cwd}: ${path}` }, workspace);
						return;
					}
					workspace.child.command("switch_session", { sessionPath: path });
				});
				return;
			}
			case "pty_start": {
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				const cols = Number(message.cols ?? 100);
				const rows = Number(message.rows ?? 30);
				const state = workspace.pty.start(Number.isFinite(cols) ? cols : 100, Number.isFinite(rows) ? rows : 30);
				socket.send(JSON.stringify({ type: "pty_state", workspace: workspace.cwd, ...state }));
				return;
			}
			case "pty_input": {
				// Typing into the terminal is a write: only the active workspace accepts it.
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				const data = String(message.data ?? "");
				if (!data) return;
				if (!workspace.pty.write(data)) {
					socket.send(JSON.stringify({ type: "error", message: "no terminal is running in this workspace" }));
				}
				return;
			}
			case "pty_resize": {
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				workspace.pty.resize(Number(message.cols ?? 100), Number(message.rows ?? 30));
				return;
			}
			case "pty_kill": {
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				workspace.pty.kill();
				return;
			}
			case "delete_session": {
				const path = String(message.path ?? "");
				if (!path) {
					broadcast({ type: "error", message: "delete_session needs a path" });
					return;
				}
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				if (message.confirmed !== true) {
					// Deleting a conversation file is destructive; make the client say it meant it.
					broadcast({ type: "error", message: "delete_session needs confirmed: true" }, workspace);
					return;
				}
				// Guarded inside deleteSession (session dir of this workspace, never the open one).
				void deleteSession(workspace.cwd, agentDir, path, { current: workspace.currentSessionPath })
					.then(() => {
						broadcast({ type: "session_deleted", path, workspace: workspace.cwd }, workspace);
						return listSessions(workspace.cwd, agentDir).then((items) =>
							broadcast({ type: "sessions", items, current: workspace.currentSessionPath, workspace: workspace.cwd }, workspace),
						);
					})
					.catch((error: unknown) => broadcast({ type: "error", message: `delete_session: ${String(error)}` }, workspace));
				return;
			}
			case "set_session_name": {
				const workspace = resolve(message, socket, true);
				workspace?.child.command("set_session_name", { name: String(message.name ?? "") });
				return;
			}
			case "compact": {
				const workspace = resolve(message, socket, true);
				workspace?.child.command("compact");
				return;
			}
			case "preview_status": {
				const workspace = resolve(message, socket, false);
				if (!workspace) return;
				socket.send(JSON.stringify(previewInfo(workspace)));
				return;
			}
			case "dev_start": {
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				const command = typeof message.command === "string" && message.command.trim() ? message.command.trim() : undefined;
				const port = typeof message.port === "number" ? message.port : undefined;
				workspace.devServer.start(workspace.preview, { command, port });
				broadcast(previewInfo(workspace), workspace);
				return;
			}
			case "dev_stop": {
				const workspace = resolve(message, socket, true);
				if (!workspace) return;
				workspace.devServer.stop();
				broadcast(previewInfo(workspace), workspace);
				return;
			}
			default:
				socket.send(JSON.stringify({ type: "error", message: `unknown client message type: ${type}` }));
		}
	}

	/**
	 * Startup workspace. An explicit `--cwd` wins (development, probes, scripts). Without it the
	 * service reopens the folder that was active when this agent dir last stopped — and on a
	 * first run, when there is nothing remembered, it opens *nothing*: silently picking a
	 * directory (a home folder, a process cwd) would start a session in a place the user never
	 * chose. The UI then asks for a folder.
	 */
	if (args.cwd) {
		try {
			activeKey = realpathSync(args.cwd);
		} catch (error) {
			console.error(`refusing to start: --cwd ${args.cwd} is not usable (${String(error)})`);
			process.exit(2);
		}
	} else {
		const remembered = rememberedWorkspace(agentDir);
		if (remembered) {
			try {
				activeKey = realpathSync(remembered);
			} catch (error) {
				console.error(`ignoring remembered workspace ${remembered} (${String(error)})`);
				activeKey = null;
			}
		}
	}
	if (activeKey) {
		// Created synchronously so the first request has an answer.
		void ensureWorkspace(activeKey).catch((error: unknown) => console.error(`workspace failed: ${String(error)})`));
	}

	void loadRecent().then(() => broadcastWorkspaces());

	server.listen(args.port, args.host, () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : args.port;
		console.log(`pi web ui on http://${args.host}:${port} (workspace ${activeKey ?? "none — waiting for the UI to open one"}, model ${args.model ?? "pi default"})`);
		// Machine-readable handshake for a desktop shell (it passes 0 and lets the OS pick a
		// port). Humans can ignore this line.
		console.log(JSON.stringify({ type: "piwebui-ready", host: args.host, port }));
	});

	const shutdown = (): void => {
		for (const workspace of workspaces.values()) workspace.dispose();
		wss.close();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 500).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

// The git POST actions are handled inside the request handler above; main() is the only entry point.

main();
