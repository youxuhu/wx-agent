/**
 * Preview websocket tunnels (hot reload).
 *
 * Facts pinned here:
 *  - a websocket dialled through the proxy prefix reaches the pinned dev server (101 + data both ways);
 *  - the tunnel is counted while open and released when it closes;
 *  - the injected shim routes a page's loopback websocket dials through the proxy, and leaves
 *    non-loopback ones alone;
 *  - an upgrade outside the proxy prefix is refused (the proxy is not an open relay).
 *
 * Requires a test agent dir with preview.json pointing at a websocket-capable upstream:
 *   node probe/preview-ws-probe.ts [port]   (default 7796)
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv[2] ?? 7796);
const BASE = `http://127.0.0.1:${port}`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Start the configured upstream and wait until the server calls it ready.
const start = await fetch(`${BASE}/api/preview`).then((r) => r.json());
if (start.status?.state !== "ready") {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise((resolve) => socket.on("open", resolve));
	socket.send(JSON.stringify({ type: "dev_start" }));
	await wait(1000);
	socket.close();
}
let preview: any = null;
for (let attempt = 0; attempt < 30; attempt++) {
	preview = await fetch(`${BASE}/api/preview`).then((r) => r.json());
	if (preview.status?.state === "ready") break;
	await wait(1000);
}
check("the configured upstream is ready (the proxy has a pinned target)", preview?.status?.state === "ready", JSON.stringify({ state: preview?.status?.state, port: preview?.status?.port, error: preview?.status?.error }));

// 2. A websocket through the proxy prefix reaches the upstream.
const tunnel = new WebSocket(`ws://127.0.0.1:${port}/__proxy/hmr`, ["vite-hmr"]);
const received: string[] = [];
tunnel.on("message", (raw: unknown) => received.push(String(raw)));
const opened = await new Promise<boolean>((resolve) => {
	tunnel.on("open", () => resolve(true));
	tunnel.on("error", () => resolve(false));
	setTimeout(() => resolve(false), 6000);
});
check("a websocket upgrade through /__proxy/ is accepted", opened);
// The upstream greets immediately; wait for it rather than racing it.
for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) await wait(200);
check("the subprotocol survived the hop", received.some((m) => m.includes("vite-hmr")), received[0]);

tunnel.send("ping-through-proxy");
for (let attempt = 0; attempt < 20 && !received.some((m) => m.includes("echo:ping-through-proxy")); attempt++) await wait(300);
check("data travels both ways", received.some((m) => m.includes("echo:ping-through-proxy")), received.join(" | ").slice(0, 120));

const during = await fetch(`${BASE}/api/preview`).then((r) => r.json());
check("the open tunnel is reported as a fact", (during.tunnels?.open ?? 0) >= 1, JSON.stringify(during.tunnels));

tunnel.close();
for (let attempt = 0; attempt < 20; attempt++) {
	const after = await fetch(`${BASE}/api/preview`).then((r) => r.json());
	if ((after.tunnels?.open ?? 0) === 0) break;
	await wait(300);
}
const after = await fetch(`${BASE}/api/preview`).then((r) => r.json());
check("closing the tunnel releases it", (after.tunnels?.open ?? 0) === 0, JSON.stringify(after.tunnels));

// 3. An upgrade outside the proxy prefix is not tunnelled anywhere.
const stray = new WebSocket(`ws://127.0.0.1:${port}/somewhere-else`);
const strayOpened = await new Promise<boolean>((resolve) => {
	stray.on("open", () => resolve(true));
	stray.on("error", () => resolve(false));
	setTimeout(() => resolve(false), 3000);
});
check("an upgrade outside the prefix is refused (not an open relay)", strayOpened === false);
stray.close();

// 4. The proxied page carries the shim that routes its own websocket dials.
const page = await fetch(`${BASE}/__proxy/`).then((r) => r.text());
check("the proxied HTML carries the websocket shim", page.includes("data-piwebui-ws="));
check("the shim still arrives with the element picker", page.includes("data-piwebui-picker="));

// 5. Behaviour of the shim itself, evaluated with a fake browser globe.
const shim = /<script data-piwebui-ws="1">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
check("the shim source could be extracted", shim.length > 100, `${shim.length} chars`);
const calls: string[] = [];
class FakeSocket {
	constructor(url: string) {
		calls.push(String(url));
	}
}
const fakeWindow = { WebSocket: FakeSocket } as { WebSocket: unknown; __piwebuiWsRewrites?: number };
const fakeLocation = { href: `${BASE}/__proxy/`, protocol: "http:", host: `127.0.0.1:${port}`, hostname: "127.0.0.1" };
const run = new Function("window", "location", "URL", shim);
run(fakeWindow, fakeLocation, URL);
const Dial = fakeWindow.WebSocket as new (url: string, protocols?: string[]) => unknown;
new Dial("ws://127.0.0.1:5188/@vite");
check("a loopback dev-server dial is routed through the proxy", calls.at(-1) === `ws://127.0.0.1:${port}/__proxy/@vite`, calls.at(-1));
check("the shim counts what it rewrote", fakeWindow.__piwebuiWsRewrites === 1, String(fakeWindow.__piwebuiWsRewrites));
new Dial("wss://example.com/socket");
check("a non-loopback dial is left alone", calls.at(-1) === "wss://example.com/socket", calls.at(-1));
new Dial(`ws://127.0.0.1:${port}/__proxy/@vite`);
check("an already-proxied dial is not rewritten twice", calls.at(-1) === `ws://127.0.0.1:${port}/__proxy/@vite`, calls.at(-1));

// 6. The panel shows the fact (static check: the panel reads the field the server sends).
const panel = readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "web", "src", "components", "PreviewPanel.vue"), "utf8");
check("the preview panel surfaces the tunnel fact", /tunnels/.test(panel), "PreviewPanel.vue");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
