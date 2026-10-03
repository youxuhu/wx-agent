/**
 * pi web ui — local Node service.
 *
 * Binds loopback only, serves the built single-page app from `dist/`, and bridges
 * a WebSocket to a supervised `pi --mode rpc` child. The browser never talks to pi
 * directly: approvals, state and events all pass through here so the invariants in
 * PLAN.md §5 can be enforced in one place.
 *
 * Usage: node server/main.ts [--port 7799] [--cwd <dir>] [--pi <bin>]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { PiRpcChild, type RpcRecord, type UiRequest } from "./rpc.ts";
import { isSessionPathOf, listSessions } from "./sessions.ts";
import { DevServer, FILE_PREFIX, PROXY_PREFIX, filePreview, loadPreviewConfig, proxyRequest, resolveProject } from "./preview.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const distDir = join(projectRoot, "dist");

interface Args {
	port: number;
	host: string;
	cwd: string;
	piBin: string;
	model?: string;
	thinking?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { port: 7799, host: "127.0.0.1", cwd: process.cwd(), piBin: "pi" };
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		const value = argv[i + 1];
		if (key === "--port" && value) args.port = Number(value);
		else if (key === "--host" && value) args.host = value;
		else if (key === "--cwd" && value) args.cwd = resolve(value);
		else if (key === "--pi" && value) args.piBin = value;
		else if (key === "--model" && value) args.model = value;
		else if (key === "--thinking" && value) args.thinking = value;
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

/** Only these methods expect an answer; the rest (notify/setStatus/setWidget/setTitle/set_editor_text) are one-way. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * RPC commands the browser may trigger. Field names follow docs/rpc-commands.md; anything
 * not listed here is refused instead of being forwarded blindly.
 */
const RPC_PASSTHROUGH: Record<string, { fields: string[]; required?: string[] }> = {
	get_commands: { fields: [] },
	get_available_models: { fields: [] },
	get_available_thinking_levels: { fields: [] },
	get_session_stats: { fields: [] },
	get_tree: { fields: [] },
	get_entries: { fields: ["since"] },
	get_fork_messages: { fields: [] },
	get_last_assistant_text: { fields: [] },
	cycle_model: { fields: [] },
	cycle_thinking_level: { fields: [] },
	abort_retry: { fields: [] },
	abort_bash: { fields: [] },
	clone: { fields: [] },
	set_model: { fields: ["provider", "modelId"], required: ["modelId"] },
	set_thinking_level: { fields: ["level"], required: ["level"] },
	set_auto_compaction: { fields: ["enabled"], required: ["enabled"] },
	set_auto_retry: { fields: ["enabled"], required: ["enabled"] },
	set_steering_mode: { fields: ["mode"], required: ["mode"] },
	set_follow_up_mode: { fields: ["mode"], required: ["mode"] },
	fork: { fields: ["entryId"], required: ["entryId"] },
	export_html: { fields: ["outputPath"] },
	bash: { fields: ["command", "excludeFromContext"], required: ["command"] },
};

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
	// Sessions live next to the config that pi itself uses (PI_CODING_AGENT_DIR wins).
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
	/** Last session file the child reported, used to mark the current row in listings. */
	let currentSessionPath: string | null = null;

	// Preview side: config read once at start, one owned dev server, one pinned upstream.
	const previewConfigPromise = loadPreviewConfig(agentDir);
	let previewProject = resolveProject(args.cwd, { projects: {} }).project;
	void previewConfigPromise.then((loaded) => {
		previewProject = resolveProject(args.cwd, loaded).project;
	});
	const previewRootPromise = previewConfigPromise.then((loaded) => resolveProject(args.cwd, loaded).project.root ?? args.cwd);
	const devServer = new DevServer(args.cwd, {
		onStatus: (status) => broadcastPreview(status),
		onLog: () => undefined,
	});
	const previewInfo = (): Record<string, unknown> => ({
		type: "preview",
		status: devServer.getStatus(),
		project: { command: previewProject.command ?? null, port: previewProject.port ?? null, readyPattern: previewProject.readyPattern ?? null, configured: Boolean(previewProject.command) },
		proxyPrefix: PROXY_PREFIX,
		filePrefix: FILE_PREFIX,
	});
	function broadcastPreview(status: ReturnType<DevServer["getStatus"]>): void {
		const payload = JSON.stringify({ ...previewInfo(), status });
		for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
	}

	// Invariant: loopback only. A non-loopback host would expose the session to the network.
	const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
	if (!loopback.has(args.host)) {
		console.error(`refusing to bind ${args.host}: only loopback hosts are allowed (use an ssh -L tunnel for remote access)`);
		process.exit(2);
	}

	const piArgs = ["--mode", "rpc"];
	if (args.model) piArgs.push("--model", args.model);
	if (args.thinking) piArgs.push("--thinking", args.thinking);
	const child = new PiRpcChild({ cwd: args.cwd, piBin: args.piBin, args: piArgs });
	/** Pending extension UI dialogs, so a reconnecting browser still sees them. */
	const pendingUi = new Map<string, UiRequest>();
	let lastStderr = "";

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://${args.host}:${args.port}`);
		if (url.pathname === "/api/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, state: child.getState(), cwd: args.cwd, pendingUi: pendingUi.size, currentSessionPath }));
			return;
		}
		if (url.pathname === "/api/sessions") {
			void listSessions(args.cwd, agentDir)
				.then((items) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ items, current: currentSessionPath, cwd: args.cwd }));
				})
				.catch((error: unknown) => {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: String(error) }));
				});
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
			})().catch((error: unknown) => {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(error) }));
			});
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
			})().catch((error: unknown) => {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: String(error) }));
			});
			return;
		}
		if (url.pathname === "/api/preview") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(previewInfo()));
			return;
		}
		if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
			const status = devServer.getStatus();
			// Invariant: one pinned loopback upstream (the dev server); no arbitrary targets.
			if (!status.port) {
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end(`refused: no local dev server upstream (state ${status.state}${status.error ? `, ${status.error}` : ""}) — start it first, or the configured port is unknown`);
				return;
			}
			void proxyRequest(req, res, { upstreamHost: "127.0.0.1", upstreamPort: status.port, pathname: url.pathname, search: url.search });
			return;
		}
		if (url.pathname === FILE_PREFIX || url.pathname.startsWith(`${FILE_PREFIX}/`)) {
			const requested = url.searchParams.get("path") ?? decodeURIComponent(url.pathname.slice(FILE_PREFIX.length));
			void previewRootPromise.then((root) => filePreview(res, root, requested));
			return;
		}
		void serveStatic(url.pathname, res);
	});

	const wss = new WebSocketServer({ server, path: "/ws" });

	const broadcast = (message: unknown): void => {
		const payload = JSON.stringify(message);
		for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
	};

	wss.on("connection", (socket: WebSocket) => {
		socket.send(
			JSON.stringify({
				type: "hello",
				state: child.getState(),
				cwd: args.cwd,
				currentSessionPath,
				exitInfo: child.getExitInfo(),
				pendingUi: [...pendingUi.values()],
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
		switch (type) {
			case "prompt": {
				const text = String(message.message ?? "");
				if (!text.trim()) return;
				if (!child.prompt(text)) {
					socket.send(JSON.stringify({ type: "error", message: "pi rpc child is not running" }));
				}
				return;
			}
			case "abort":
				child.command("abort");
				return;
			case "steer":
				child.command("steer", { message: String(message.message ?? "") });
				return;
			case "new_session":
				child.command("new_session");
				return;
			case "get_state":
				child.command("get_state");
				return;
			case "get_messages":
				child.command("get_messages");
				return;
			case "list_sessions":
				void listSessions(args.cwd, agentDir)
					.then((items) => socket.send(JSON.stringify({ type: "sessions", items, current: currentSessionPath })))
					.catch((error: unknown) => socket.send(JSON.stringify({ type: "error", message: `list_sessions failed: ${String(error)}` })));
				return;
			case "switch_session": {
				const path = String(message.path ?? "");
				if (!path) {
					broadcast({ type: "error", message: "switch_session needs a path" });
					return;
				}
				// Invariant: only session files of this cwd's session directory may be loaded.
				void isSessionPathOf(args.cwd, agentDir, path).then((ok) => {
					if (!ok) {
						broadcast({ type: "error", message: `refused: not a session file of ${args.cwd}: ${path}` });
						return;
					}
					child.command("switch_session", { sessionPath: path });
				});
				return;
			}
			case "set_session_name":
				child.command("set_session_name", { name: String(message.name ?? "") });
				return;
			case "compact":
				child.command("compact");
				return;
			case "ui_response": {
				const id = String(message.id ?? "");
				if (!pendingUi.has(id)) {
					socket.send(JSON.stringify({ type: "error", message: `unknown or already answered dialog: ${id}` }));
					return;
				}
				pendingUi.delete(id);
				// Only forward explicit answers. A dismissed dialog says so.
				const response: Record<string, unknown> =
					message.cancelled === true
						? { cancelled: true }
						: message.confirmed !== undefined
							? { confirmed: Boolean(message.confirmed) }
							: { value: message.value ?? undefined };
				child.respondUi(id, response);
				broadcast({ type: "ui_resolved", id, response });
				return;
			}
			case "preview_status":
				socket.send(JSON.stringify(previewInfo()));
				return;
			case "dev_start": {
				const command = typeof message.command === "string" && message.command.trim() ? message.command.trim() : undefined;
				const port = typeof message.port === "number" ? message.port : undefined;
				void previewConfigPromise.then(() => {
					const next = devServer.start(previewProject, { command, port });
					broadcast({ ...previewInfo(), status: next });
				});
				return;
			}
			case "dev_stop":
				broadcast({ ...previewInfo(), status: devServer.stop() });
				return;
			default: {
				const spec = RPC_PASSTHROUGH[type];
				if (!spec) {
					socket.send(JSON.stringify({ type: "error", message: `unknown client message type: ${type}` }));
					return;
				}
				const passPayload: Record<string, unknown> = {};
				for (const field of spec.fields) if (message[field] !== undefined) passPayload[field] = message[field];
				const missing = (spec.required ?? []).filter((field) => passPayload[field] === undefined);
				if (missing.length) {
					socket.send(JSON.stringify({ type: "error", message: `${type} needs ${missing.join(", ")}` }));
					return;
				}
				// hand the message id through so streaming events can be correlated
				child.command(type, passPayload, typeof message.id === "string" ? message.id : undefined);
				return;
			}
		}
	}

	child.on("record", (record: RpcRecord) => {
		// Track the current session file so listings can mark it.
		if (record.type === "response" && record.command === "get_state") {
			const data = record.data as { sessionFile?: string } | undefined;
			if (data?.sessionFile) currentSessionPath = data.sessionFile;
		}
		if (record.type === "response" && record.command === "switch_session") {
			const data = record.data as { cancelled?: boolean } | undefined;
			if (!data?.cancelled) currentSessionPath = (record as { sessionPath?: string }).sessionPath ?? currentSessionPath;
		}
		if (record.type === "extension_ui_request") {
			const request = record as unknown as UiRequest;
			if (!DIALOG_METHODS.has(request.method)) {
				// one-way record: forward to the UI, nothing to answer
				broadcast({ type: "record", record });
				return;
			}
			pendingUi.set(request.id, request);
			broadcast({ type: "record", record });
			// A dialog with a deadline: show it with the deadline, and on expiry report a
			// cancellation to pi (never an automatic "allow").
			if (typeof request.timeout === "number" && request.timeout > 0) {
				setTimeout(() => {
					if (!pendingUi.has(request.id)) return;
					pendingUi.delete(request.id);
					child.respondUi(request.id, { cancelled: true });
					broadcast({ type: "ui_resolved", id: request.id, response: { cancelled: true }, reason: "timeout" });
				}, request.timeout);
			}
			return;
		}
		broadcast({ type: "record", record });
	});

	child.on("state", (info: unknown) => broadcast({ type: "pi_state", ...(info as object) }));
	child.on("stderr", (chunk: string) => {
		lastStderr = `${lastStderr}${chunk}`.slice(-4000);
		broadcast({ type: "pi_stderr", chunk: chunk.slice(-2000) });
	});
	child.on("malformed", (line: string) => broadcast({ type: "malformed", line: line.slice(0, 500) }));

	child.start();

	server.listen(args.port, args.host, () => {
		console.log(
			`pi web ui on http://${args.host}:${args.port} (cwd ${args.cwd}, model ${args.model ?? "pi default"}, pi rpc child started)`,
		);
		if (lastStderr) console.error(lastStderr);
	});

	const shutdown = (): void => {
		devServer.dispose();
		child.stop();
		wss.close();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 500).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
