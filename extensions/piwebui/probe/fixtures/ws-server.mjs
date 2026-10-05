/**
 * Websocket-capable upstream fixture for `probe/preview-ws-probe.ts`.
 *
 * The probe dials a websocket through the proxy and expects it to reach this server: it echoes
 * what it receives, and greets each connection with the subprotocol it was offered (so the probe
 * can check that the subprotocol survives the hop). The HTTP side serves a page carrying a
 * websocket dial, which is what the injected shim is for.
 *
 * Usage: node probe/fixtures/ws-server.mjs [port]
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 5188);
const page = `<!doctype html><html><head><title>ws fixture</title></head><body>
<script>new WebSocket("ws://127.0.0.1:${port}/hmr", ["vite-hmr"]);</script>
</body></html>`;

const server = createServer((req, res) => {
	if (req.url === "/") {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(page);
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("nope");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket, request) => {
	const protocol = request.headers["sec-websocket-protocol"];
	socket.send(JSON.stringify({ hello: protocol ?? null }));
	socket.on("message", (data, isBinary) => socket.send(isBinary ? data : `echo:${data}`));
});

server.listen(port, "127.0.0.1");
