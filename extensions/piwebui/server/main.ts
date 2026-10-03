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
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { PiRpcChild, type RpcRecord, type UiRequest } from "./rpc.ts";

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

function main(): void {
	const args = parseArgs(process.argv.slice(2));

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
			res.end(JSON.stringify({ ok: true, state: child.getState(), cwd: args.cwd, pendingUi: pendingUi.size }));
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
			case "compact":
				child.command("compact");
				return;
			case "set_model":
				child.command("set_model", { model: String(message.model ?? "") });
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
			default:
				socket.send(JSON.stringify({ type: "error", message: `unknown client message type: ${type}` }));
		}
	}

	child.on("record", (record: RpcRecord) => {
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
		child.stop();
		wss.close();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 500).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
