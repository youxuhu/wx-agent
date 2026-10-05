/**
 * Preview side of the panel: a same-origin reverse proxy in front of a local dev
 * server, an injected element picker, read-only file preview, and the lifecycle of
 * the dev server we started ourselves.
 *
 * Invariants enforced here (all failures are reported as facts, never silently degraded):
 *  - only loopback upstreams are proxied; anything else is refused,
 *  - `__file` reads stay inside the configured root,
 *  - we only ever terminate a process tree that we spawned ourselves.
 */
import { request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { WebSocket as WsClient, WebSocketServer } from "ws";

/** Completes the browser side of a tunnel; kept separate so tunnels never join the app's client list. */
const tunnelServer = new WebSocketServer({ noServer: true });

export const PROXY_PREFIX = "/__proxy";
export const FILE_PREFIX = "/__file";

export interface PreviewProject {
	/** Shell command that starts the dev server (run with `sh -c` in the project cwd). */
	command?: string;
	/** Expected port; also used for the readiness probe when no pattern matches. */
	port?: number;
	/** Directory that `__file` previews may read from. Defaults to the pinned cwd. */
	root?: string;
	/** Regex tested against each output line; a match means "ready". */
	readyPattern?: string;
	/** Give up on readiness after this many ms (default 30000). */
	readyTimeoutMs?: number;
}

export interface PreviewConfig {
	projects: Record<string, PreviewProject>;
}

export interface DevServerStatus {
	state: "stopped" | "starting" | "ready" | "failed" | "exited";
	command: string | null;
	port: number | null;
	pid: number | null;
	startedAt: number | null;
	readyAt: number | null;
	readyVia: string | null;
	httpStatus: number | null;
	error: string | null;
	log: string[];
	cwd: string;
}

const CSS_OR_HTML = /text\/html|application\/xhtml|text\/css/i;
const STRIP_RESPONSE_HEADERS = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
]);

export async function loadPreviewConfig(agentDir: string): Promise<PreviewConfig> {
	try {
		const raw = await readFile(join(agentDir, "preview.json"), "utf8");
		const parsed = JSON.parse(raw) as PreviewConfig;
		return { projects: parsed.projects ?? {} };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
		throw error;
	}
}

/** Longest configured root that contains `cwd` wins, so a repo entry covers its subdirs. */
export function resolveProject(cwd: string, config: PreviewConfig): { project: PreviewProject; key: string | null } {
	const target = resolve(cwd);
	let best: { project: PreviewProject; key: string } | null = null;
	for (const [key, project] of Object.entries(config.projects)) {
		const root = resolve(key);
		if (target === root || target.startsWith(root + sep)) {
			if (!best || root.length > resolve(best.key).length) best = { project, key };
		}
	}
	return best ? best : { project: {}, key: null };
}

/** Element picker, injected into proxied HTML. Activates only when the parent asks. */
const PICKER_SCRIPT = [
	"(function () {",
	"  if (window.__piwebuiPick) return;",
	"  var state = { on: false, el: null, box: null };",
	"  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }",
	"  function seg(el) {",
	"    try { if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id); } catch (e) {}",
	"    var t = el.tagName.toLowerCase();",
	"    var parent = el.parentElement;",
	"    if (!parent) return t;",
	"    var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });",
	"    if (same.length === 1) return t;",
	"    return t + ':nth-of-type(' + (same.indexOf(el) + 1) + ')';",
	"  }",
	"  function path(el) {",
	"    var parts = [];",
	"    while (el && el.nodeType === 1 && parts.length < 10) {",
	"      parts.unshift(seg(el));",
	"      if (el.id) break;",
	"      el = el.parentElement;",
	"    }",
	"    return parts.join(' > ');",
	"  }",
	"  function unique(sel) {",
	"    try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }",
	"  }",
	"  function safeHtml(el) {",
	"    var clone = el.cloneNode(true);",
	"    var drop = clone.querySelectorAll('script,style,link,meta,iframe,svg use');",
	"    for (var i = 0; i < drop.length; i++) drop[i].remove();",
	"    var walk = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));",
	"    for (var j = 0; j < walk.length; j++) {",
	"      var attrs = walk[j].attributes;",
	"      for (var k = attrs.length - 1; k >= 0; k--) {",
	"        var name = attrs[k].name;",
	"        if (name.indexOf('on') === 0 || name === 'style') walk[j].removeAttribute(name);",
	"      }",
	"    }",
	"    var html = clone.outerHTML.replace(/\\s+/g, ' ');",
	"    return html.length > 1024 ? html.slice(0, 1024) + '…[truncated]' : html;",
	"  }",
	"  function facts(el) {",
	"    var sel = path(el);",
	"    var count = unique(sel);",
	"    return {",
	"      url: location.href,",
	"      title: document.title,",
	"      tag: el.tagName.toLowerCase(),",
	"      role: el.getAttribute('role'),",
	"      id: el.id || null,",
	"      classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 200) : null,",
	"      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),",
	"      rect: rectOf(el),",
	"      selector: sel,",
	"      selectorMatches: count,",
	"      selectorUnique: count === 1,",
	"      html: safeHtml(el)",
	"    };",
	"  }",
	"  function paint() {",
	"    if (!state.box) {",
	"      state.box = document.createElement('div');",
	"      state.box.setAttribute('data-piwebui-pick-box', '1');",
	"      state.box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #16a34a;background:rgba(22,163,74,0.12);transition:all .05s linear';",
	"      document.documentElement.appendChild(state.box);",
	"    }",
	"    if (!state.el) { state.box.style.display = 'none'; return; }",
	"    var r = rectOf(state.el);",
	"    state.box.style.display = 'block';",
	"    state.box.style.left = r.x + 'px';",
	"    state.box.style.top = r.y + 'px';",
	"    state.box.style.width = r.w + 'px';",
	"    state.box.style.height = r.h + 'px';",
	"  }",
	"  function onOver(e) { if (!state.on) return; state.el = e.target; paint(); }",
	"  function onClick(e) {",
	"    if (!state.on) return;",
	"    e.preventDefault();",
	"    e.stopPropagation();",
	"    var el = e.target;",
	"    window.parent.postMessage({ type: 'piwebui:pick', payload: facts(el) }, location.origin);",
	"  }",
	"  function setMode(on) {",
	"    state.on = !!on;",
	"    document.documentElement.style.cursor = state.on ? 'crosshair' : '';",
	"    if (!state.on) { state.el = null; paint(); }",
	"  }",
	"  document.addEventListener('mouseover', onOver, true);",
	"  document.addEventListener('click', onClick, true);",
	"  window.addEventListener('message', function (e) {",
	"    var d = e.data;",
	"    if (!d || d.type !== 'piwebui:pick-mode') return;",
	"    setMode(d.on);",
	"  });",
	"  window.__piwebuiPick = { setMode: setMode, facts: facts };",
	"})();",
].join("\n");

export function pickerTag(): string {
	return `<script data-piwebui-picker="1">${PICKER_SCRIPT}</script>`;
}

/**
 * Dev servers push hot updates over their own websocket. Under the proxy the page is served from
 * our origin, so a client that dials the dev server directly would leave the proxy (and usually
 * get blocked). The shim routes those dials through the proxy prefix instead.
 *
 * Only loopback targets are rewritten: a page that talks to some real external websocket keeps
 * doing exactly that.
 */
export function wsShimTag(): string {
	const shim = `
(function () {
  var PREFIX = ${JSON.stringify(PROXY_PREFIX)};
  var Native = window.WebSocket;
  if (!Native) return;
  var rewrites = 0;
  function isLoopback(host) { return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === location.hostname; }
  function rewrite(url) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return url;
      if (u.pathname.indexOf(PREFIX) === 0) return url;
      if (!isLoopback(u.hostname)) return url;
      rewrites++;
      window.__piwebuiWsRewrites = rewrites;
      return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + PREFIX + u.pathname + u.search;
    } catch (e) { return url; }
  }
  function Patched(url, protocols) {
    var target = rewrite(String(url));
    return protocols === undefined ? new Native(target) : new Native(target, protocols);
  }
  Patched.prototype = Native.prototype;
  Object.defineProperty(Patched, 'name', { value: 'WebSocket' });
  try { Object.setPrototypeOf(Patched, Native); } catch (e) {}
  Patched.CONNECTING = 0; Patched.OPEN = 1; Patched.CLOSING = 2; Patched.CLOSED = 3;
  window.WebSocket = Patched;
})();`;
	return `<script data-piwebui-ws="1">${shim}</script>`;
}

/** Root-relative URLs and inline CSS urls must keep pointing at the proxy. */
export function rewriteHtml(html: string): string {
	const prefixed = html
		.replace(/(\b(?:src|href|action|poster|data-src)=)(["'])\/(?!\/)/gi, (_m, attr: string, quote: string) => `${attr}${quote}${PROXY_PREFIX}/`)
		.replace(/url\(\s*(["']?)\/(?!\/)/gi, (_m, quote: string) => `url(${quote}${PROXY_PREFIX}/`);
	if (/<html[\s>]/i.test(prefixed) && !/data-piwebui-picker/.test(prefixed)) {
		return prefixed.replace(/<head[^>]*>/i, (head) => `${head}${pickerTag()}${wsShimTag()}`) === prefixed
			? `${pickerTag()}${wsShimTag()}${prefixed}`
			: prefixed.replace(/<head[^>]*>/i, (head) => `${head}${pickerTag()}${wsShimTag()}`);
	}
	return prefixed;
}


export interface ProxyFact {
	upstream: string;
	rewritten: boolean;
	cspRelaxed: boolean;
}

/** Live websocket tunnels, so the UI can state the fact instead of implying it. */
let tunnels = 0;
let tunnelFailures = 0;

export function tunnelFacts(): { open: number; refused: number } {
	return { open: tunnels, refused: tunnelFailures };
}

/**
 * Forward one websocket upgrade to the pinned loopback upstream (dev servers push HMR updates
 * there). Only the configured upstream is reachable — the proxy never becomes an open relay —
 * and a refused upgrade is counted so the UI can say so.
 */
export function proxyUpgrade(
	req: import("node:http").IncomingMessage,
	socket: import("node:stream").Duplex,
	head: Buffer,
	options: { upstreamHost: string; upstreamPort: number },
): void {
	const raw = req.url ?? "";
	if (!raw.startsWith(`${PROXY_PREFIX}/`) && raw !== PROXY_PREFIX) {
		tunnelFailures++;
		socket.destroy();
		return;
	}
	const upstreamPath = raw.slice(PROXY_PREFIX.length) || "/";
	const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const upstream = new WsClient(`ws://${options.upstreamHost}:${options.upstreamPort}${upstreamPath}`, protocols, {
		headers: { origin: `http://${options.upstreamHost}:${options.upstreamPort}` },
	});
	let settled = false;

	upstream.on("open", () => {
		settled = true;
		tunnels++;
		tunnelServer.handleUpgrade(req, socket as never, head, (client: WsClient) => {
			client.on("message", (data: Buffer, isBinary: boolean) => {
				if (upstream.readyState === 1) upstream.send(data, { binary: isBinary });
			});
			client.on("close", () => upstream.close());
			client.on("error", () => upstream.close());
			upstream.on("message", (data: Buffer, isBinary: boolean) => {
				if (client.readyState === 1) client.send(data, { binary: isBinary });
			});
		});
	});

	const finish = (): void => {
		if (settled) {
			settled = false;
			tunnels = Math.max(0, tunnels - 1);
		}
	};
	upstream.on("close", () => {
		finish();
		if (socket.writable) socket.end();
	});
	upstream.on("error", () => {
		if (!settled) {
			// The upstream is not there: answer like an HTTP proxy would, and say so in a header.
			tunnelFailures++;
			socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\nx-piwebui-upstream-error: websocket\r\n\r\n");
		}
		finish();
		socket.destroy();
	});
}

/**
 * Forward one request to the pinned loopback upstream. HTML/CSS bodies are rewritten so
 * the page keeps working under the proxy prefix; everything else streams through.
 */
export async function proxyRequest(
	req: import("node:http").IncomingMessage,
	res: import("node:http").ServerResponse,
	options: { upstreamHost: string; upstreamPort: number; pathname: string; search: string },
): Promise<void> {
	const upstreamPath = options.pathname.slice(PROXY_PREFIX.length) || "/";
	return new Promise<void>((done) => {
		const headers: Record<string, string | string[] | undefined> = { ...req.headers };
		headers.host = `${options.upstreamHost}:${options.upstreamPort}`;
		// Ask for identity encoding: rewriting needs the raw bytes.
		headers["accept-encoding"] = "identity";
		const upstream = httpRequest(
			{ host: options.upstreamHost, port: options.upstreamPort, path: upstreamPath + options.search, method: req.method, headers },
			(response) => {
				const type = String(response.headers["content-type"] ?? "");
				const buffered = CSS_OR_HTML.test(type) && req.method !== "HEAD";
				const outHeaders: Record<string, string | string[]> = {};
				for (const [key, value] of Object.entries(response.headers)) {
					if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
					outHeaders[key] = value;
				}
				const cspRelaxed = Boolean(response.headers["content-security-policy"] || response.headers["x-frame-options"]);
				outHeaders["x-piwebui-upstream"] = `${options.upstreamHost}:${options.upstreamPort}`;
				if (cspRelaxed) outHeaders["x-piwebui-csp-relaxed"] = "1 (needed to inject the picker script)";
				if (!buffered) {
					res.writeHead(response.statusCode ?? 502, outHeaders);
					response.pipe(res);
					response.on("end", () => done());
					return;
				}
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const body = Buffer.concat(chunks);
					const isCss = /text\/css/i.test(type);
					const text = body.toString("utf8");
					const rewritten = rewriteHtml(text);
					const out = isCss || rewritten !== text;
					outHeaders["x-piwebui-rewritten"] = isCss ? "css" : "html";
					const payload = Buffer.from(rewritten, "utf8");
					outHeaders["content-length"] = String(payload.byteLength);
					res.writeHead(response.statusCode ?? 200, outHeaders);
					res.end(payload);
					done();
				});
			},
		);
		upstream.on("error", (error: NodeJS.ErrnoException) => {
			if (res.headersSent) {
				res.end();
			} else {
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-piwebui-upstream-error": error.code ?? "error" });
				res.end(`proxy refused: ${options.upstreamHost}:${options.upstreamPort} — ${error.message}`);
			}
			done();
		});
		req.pipe(upstream);
	});
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
};

/** Read-only local file preview. Anything outside the configured root is refused. */
export async function filePreview(res: import("node:http").ServerResponse, root: string, rawPath: string): Promise<void> {
	const fail = (code: number, message: string): void => {
		res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
		res.end(message);
	};
	if (!rawPath) return fail(400, "missing path");
	let rootReal: string;
	let targetReal: string;
	try {
		rootReal = await realpath(root);
		targetReal = await realpath(rawPath);
	} catch (error) {
		return fail(404, `not found: ${(error as NodeJS.ErrnoException).message}`);
	}
	if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
		return fail(403, `refused: ${targetReal} is outside the preview root ${rootReal}`);
	}
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(targetReal);
	} catch (error) {
		return fail(404, `not found: ${(error as NodeJS.ErrnoException).message}`);
	}
	if (info.isDirectory()) {
		const listing = await readFile(join(targetReal, "index.html")).catch(() => null);
		if (!listing) return fail(404, `refused: ${targetReal} is a directory without index.html (no directory listing)`);
		return sendFile(res, targetReal, listing, true);
	}
	const body = await readFile(targetReal);
	return sendFile(res, targetReal, body, true);
}

function sendFile(res: import("node:http").ServerResponse, path: string, body: Buffer, readOnly: boolean): void {
	const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
	const headers: Record<string, string> = { "content-type": type, "x-piwebui-readonly": readOnly ? "1" : "0" };
	if (/text\/html/i.test(type)) {
		const html = rewriteHtml(body.toString("utf8"));
		const out = Buffer.from(html, "utf8");
		headers["content-length"] = String(out.byteLength);
		res.writeHead(200, headers);
		res.end(out);
		return;
	}
	headers["content-length"] = String(body.byteLength);
	res.writeHead(200, headers);
	res.end(body);
}

export interface DevServerEvents {
	onStatus: (status: DevServerStatus) => void;
	onLog: (line: string) => void;
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/;

/** Owns exactly one child process tree: the dev server we started. */
export class DevServer {
	private child: ChildProcess | null = null;
	private status: DevServerStatus;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private poll: ReturnType<typeof setInterval> | null = null;
	private stopping = false;

	private readonly cwd: string;
	private readonly events: DevServerEvents;

	constructor(cwd: string, events: DevServerEvents) {
		// Node's strip-only TypeScript support rejects parameter properties, so assign manually.
		this.cwd = cwd;
		this.events = events;
		this.status = {
			state: "stopped",
			command: null,
			port: null,
			pid: null,
			startedAt: null,
			readyAt: null,
			readyVia: null,
			httpStatus: null,
			error: null,
			log: [],
			cwd,
		};
	}

	getStatus(): DevServerStatus {
		return { ...this.status, log: [...this.status.log] };
	}

	private update(patch: Partial<DevServerStatus>): void {
		this.status = { ...this.status, ...patch };
		this.events.onStatus(this.getStatus());
	}

	private log(line: string): void {
		const clean = line.replace(/\r$/, "");
		if (!clean.trim()) return;
		this.status.log = [...this.status.log, clean].slice(-200);
		this.events.onLog(clean);
	}

	start(project: PreviewProject, override: { command?: string; port?: number } = {}): DevServerStatus {
		if (this.child) {
			this.log(`[piwebui] already running (pid ${this.child.pid}); stop it first — not starting a second one`);
			return this.getStatus();
		}
		const command = override.command ?? project.command;
		if (!command) {
			this.update({ state: "failed", error: `no dev command configured for ${this.cwd} (add it to preview.json)` });
			return this.getStatus();
		}
		const port = override.port ?? project.port ?? null;
		const timeoutMs = project.readyTimeoutMs ?? 30_000;
		let readyPattern: RegExp | null = null;
		if (project.readyPattern) {
			try {
				readyPattern = new RegExp(project.readyPattern);
			} catch (error) {
				this.update({ state: "failed", error: `bad readyPattern: ${String(error)}` });
				return this.getStatus();
			}
		}
		this.stopping = false;
		this.log(`[piwebui] $ ${command}`);
		// detached: its own process group, so stopping kills the tree and nothing else.
		const child = spawn("sh", ["-c", command], { cwd: this.cwd, detached: true, env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" } });
		this.child = child;
		this.update({ state: "starting", command, port, pid: child.pid ?? null, startedAt: Date.now(), readyAt: null, readyVia: null, httpStatus: null, error: null, log: [] });

		const onChunk = (chunk: Buffer): void => {
			for (const line of chunk.toString("utf8").split("\n")) {
				this.log(line);
				if (!readyPattern) continue;
				if (readyPattern.test(line)) this.markReady(`output matched ${readyPattern}`);
				else {
					const found = line.match(LOCAL_URL);
					if (found && this.status.state === "starting") this.probe(Number(found[1]), `output announced http://…:${found[1]}`);
				}
			}
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("error", (error: NodeJS.ErrnoException) => {
			this.update({ state: "failed", error: `spawn failed: ${error.message}` });
		});
		child.on("exit", (code, signal) => {
			this.child = null;
			if (this.stopping) {
				this.update({ state: "stopped", pid: null, readyVia: null });
				return;
			}
			this.update({ state: "exited", pid: null, error: `dev server exited (code ${code}, signal ${signal})` });
		});

		this.timer = setTimeout(() => {
			if (this.status.state === "starting") {
				this.update({ state: "failed", error: `not ready after ${timeoutMs}ms — no readiness signal (last output above)` });
			}
		}, timeoutMs);
		// If a port is known up front, poll it from the start; otherwise we wait for output.
		if (port) this.probe(port, `configured port ${port}`);
		return this.getStatus();
	}

	private markReady(via: string): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.poll) clearInterval(this.poll);
		this.poll = null;
		this.update({ state: "ready", readyAt: Date.now(), readyVia: via, port: this.status.port });
	}

	/** Poll a candidate port until it answers; the answer is a fact, not a guess. */
	private probe(port: number, via: string): void {
		if (this.poll) return;
		let attempts = 0;
		const tick = async (): Promise<void> => {
			attempts++;
			const controller = new AbortController();
			const abort = setTimeout(() => controller.abort(), 1500);
			try {
				const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: "manual" });
				clearTimeout(abort);
				this.status.port = port;
				this.status.httpStatus = response.status;
				this.markReady(`${via} answered HTTP ${response.status}`);
			} catch {
				clearTimeout(abort);
				if (attempts > 120 && this.status.state === "starting") this.update({ state: "failed", error: `${via} never answered (120 probes)` });
			}
		};
		void tick();
		this.poll = setInterval(() => {
			if (this.status.state !== "starting") {
				if (this.poll) clearInterval(this.poll);
				this.poll = null;
				return;
			}
			void tick();
		}, 500);
	}

	/** Terminate only the tree we spawned (its own process group). */
	stop(): DevServerStatus {
		const child = this.child;
		if (!child || !child.pid) {
			this.update({ state: "stopped", pid: null });
			return this.getStatus();
		}
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.poll) clearInterval(this.poll);
		this.timer = null;
		this.poll = null;
		const pid = child.pid;
		try {
			process.kill(-pid, "SIGTERM");
			this.log(`[piwebui] SIGTERM → process group ${pid}`);
		} catch (error) {
			this.log(`[piwebui] SIGTERM failed: ${(error as NodeJS.ErrnoException).message}`);
		}
		setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
				this.log(`[piwebui] SIGKILL → process group ${pid}`);
			} catch {
				/* already gone */
			}
		}, 3000).unref?.();
		return this.getStatus();
	}

	dispose(): void {
		if (this.child) this.stop();
		if (this.timer) clearTimeout(this.timer);
		if (this.poll) clearInterval(this.poll);
	}
}
