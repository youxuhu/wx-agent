/**
 * Preview-side acceptance probe: dev server lifecycle, proxy rewriting, grounding of the
 * upstream, read-only file preview and refusal facts. Facts only, no retries.
 */
import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:7801";
const WS = BASE.replace("http", "ws") + "/ws";

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path, headers = {}) {
	const response = await fetch(BASE + path, { headers, redirect: "manual" });
	const body = await response.text();
	return { status: response.status, headers: response.headers, body };
}

function connect() {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(WS);
		const messages = [];
		socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		socket.on("open", () => resolve({ socket, messages, send: (m) => socket.send(JSON.stringify(m)) }));
		socket.on("error", reject);
	});
}

const waitFor = async (fn, ms = 20000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 300));
	}
	return null;
};

const { socket, messages, send } = await connect();

// 1. No upstream yet → the proxy refuses instead of guessing.
const before = await get("/__proxy/");
check("proxy refuses while no dev server is known", before.status === 502 && /refused/.test(before.body), `${before.status} ${before.body.slice(0, 90)}`);

// 2. Lifecycle: start from preview.json, reach "ready" with a real HTTP answer.
send({ type: "dev_start" });
const ready = await waitFor(() => messages.map((m) => m.status).filter(Boolean).reverse().find((s) => s?.state === "ready" || s?.state === "failed"));
check("dev_start reaches ready", ready?.state === "ready", JSON.stringify({ state: ready?.state, port: ready?.port, httpStatus: ready?.httpStatus, via: ready?.readyVia, error: ready?.error }));
check("readiness is proven by an HTTP answer", ready?.httpStatus === 200, `http ${ready?.httpStatus} via ${ready?.readyVia}`);

// 3. Proxy: HTML rewritten to stay under the prefix, picker injected, CSP relaxed and reported.
const index = await get("/__proxy/");
check("proxied HTML: 200", index.status === 200, `status ${index.status}`);
check("proxied HTML: absolute refs rewritten", index.body.includes('href="/__proxy/style.css"') && index.body.includes('src="/__proxy/main.js"'), "href/src prefixed");
check("proxied HTML: picker injected", index.body.includes("data-piwebui-picker"));
check("strict CSP stripped and reported as a fact", !index.headers.get("content-security-policy") && Boolean(index.headers.get("x-piwebui-csp-relaxed")), `csp-relaxed=${index.headers.get("x-piwebui-csp-relaxed")} xfo=${index.headers.get("x-frame-options")}`);
check("upstream is reported on the response", index.headers.get("x-piwebui-upstream") === "127.0.0.1:5199", String(index.headers.get("x-piwebui-upstream")));

// 4. CSS is rewritten too; JS/JSON are not touched.
const css = await get("/__proxy/style.css");
check("proxied CSS: url() rewritten", css.body.includes("url(/__proxy/bg.png)"), css.body.slice(0, 60));
const js = await get("/__proxy/main.js");
check("proxied JS passes through untouched", js.body.includes("window.fixture = 1") && !js.body.includes("__proxy"), js.headers.get("x-piwebui-rewritten") ?? "not rewritten");

// 5. Sub-page navigation through the proxy.
const other = await get("/__proxy/other.html");
check("sub-page served through the proxy", other.status === 200 && other.body.includes("other page"), `status ${other.status}`);

// 6. file:// preview is read-only and confined to the configured root.
const insideRoot = await get(`/__file/?path=${encodeURIComponent("/tmp/piwebui-preview/index.html")}`);
check("file preview inside the root works", insideRoot.status === 200 && insideRoot.headers.get("x-piwebui-readonly") === "1", `status ${insideRoot.status} readonly=${insideRoot.headers.get("x-piwebui-readonly")}`);
const outsideRoot = await get(`/__file/?path=${encodeURIComponent("/etc/hosts")}`);
check("file preview outside the root is refused", outsideRoot.status === 403 && /outside the preview root/.test(outsideRoot.body), `${outsideRoot.status} ${outsideRoot.body.slice(0, 80)}`);
const traversal = await get(`/__file/?path=${encodeURIComponent("/tmp/piwebui-preview/../piwebui-testagent/policy.json")}`);
check("path traversal via .. is refused", traversal.status === 403, `${traversal.status} ${traversal.body.slice(0, 60)}`);

// 7. Stop must terminate the tree we spawned and flip the state.
const pid = ready?.pid ?? null;
send({ type: "dev_stop" });
const stopped = await waitFor(() => messages.map((m) => m.status).filter(Boolean).reverse().find((s) => s?.state === "stopped"), 10000);
check("dev_stop reports stopped", stopped?.state === "stopped", JSON.stringify({ state: stopped?.state, pid: stopped?.pid }));
await new Promise((r) => setTimeout(r, 800));
let alive = false;
try {
	process.kill(pid, 0);
	alive = true;
} catch {
	alive = false;
}
check("spawned process group is gone", !alive, `pid ${pid} alive=${alive}`);
const after = await get("/__proxy/");
check("proxy refuses again after stop", after.status === 502, `status ${after.status}`);

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
