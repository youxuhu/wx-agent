/**
 * Upstream fixture for `probe/preview-probe.ts`.
 *
 * The probe asserts exact rewritten URLs, so the fixture must serve these exact names:
 *   /            HTML with root-relative refs + a strict CSP and X-Frame-Options (relaxed by the proxy)
 *   /style.css   a root-relative url() inside CSS
 *   /main.js     JavaScript that must pass through untouched
 *   /bg.png      any bytes
 *   /other.html  a second page, for sub-page navigation
 *
 * It prints nothing: readiness is then proven by the proxy's own HTTP probe (that is what the
 * probe checks), instead of by an output pattern.
 *
 * Usage: node probe/fixtures/preview-server.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 5199);
const html = [
	"<!doctype html><html><head><title>preview fixture</title>",
	'<link rel="stylesheet" href="/style.css">',
	'<script src="/main.js"></script>',
	"</head><body><p>preview fixture</p></body></html>",
].join("\n");

createServer((req, res) => {
	const url = (req.url ?? "/").split("?")[0];
	if (url === "/style.css") {
		res.writeHead(200, { "content-type": "text/css" });
		res.end("body { background: url(/bg.png); }");
		return;
	}
	if (url === "/main.js") {
		res.writeHead(200, { "content-type": "application/javascript" });
		res.end("window.fixture = 1;");
		return;
	}
	if (url === "/bg.png") {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		return;
	}
	if (url === "/other.html") {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><body>other page</body></html>");
		return;
	}
	res.writeHead(200, {
		"content-type": "text/html",
		"content-security-policy": "default-src 'none'",
		"x-frame-options": "DENY",
	});
	res.end(html);
}).listen(port, "127.0.0.1");
