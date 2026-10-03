/** File panel acceptance: tree listing, .gitignore flags, and every refusal path. */
import { WebSocket } from "ws";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://127.0.0.1:7799";
const FIX = process.env.FIXTURE ?? "/tmp/piwebui-files";
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(FIX, { recursive: true, force: true });
await mkdir(`${FIX}/src`, { recursive: true });
await mkdir(`${FIX}/node_modules`, { recursive: true });
await writeFile(`${FIX}/index.html`, "<html><body>hi</body></html>");
await writeFile(`${FIX}/src/app.ts`, "export const answer = 42;\n");
await writeFile(`${FIX}/node_modules/dep.js`, "module.exports = 1;\n");
await writeFile(`${FIX}/.gitignore`, "node_modules\n");
await writeFile(`${FIX}/big.txt`, "x".repeat(3 * 1024 * 1024));
await writeFile(`${FIX}/blob.bin`, Buffer.from([1, 0, 2, 3, 0, 4]));
await symlink("/etc/hosts", `${FIX}/escape`).catch(() => undefined);
await new Promise((resolve) => execFile("git", ["init", "-q", "-b", "main"], { cwd: FIX }, () => resolve()));

const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
await new Promise((resolve, reject) => {
	socket.on("open", resolve);
	socket.on("error", reject);
});
socket.send(JSON.stringify({ type: "switch_workspace", path: FIX }));
await wait(1500);
const active = (await (await fetch(`${BASE}/api/health`)).json()).active;
const q = (p) => `${BASE}${p}${p.includes("?") ? "&" : "?"}ws=${encodeURIComponent(active)}`;

const tree = await (await fetch(q("/api/tree"))).json();
const names = tree.entries.map((e) => e.name);
check("tree lists the directory, dirs first", tree.entries[0].type === "dir" && names.includes("index.html") && names.includes("src"), names.join(", "));
check(".git is never descended into", !names.includes(".git"), names.join(", "));
check("gitignored entries are flagged", tree.entries.find((e) => e.name === "node_modules")?.ignored === true, JSON.stringify(tree.entries.find((e) => e.name === "node_modules")));
const withIgnored = await (await fetch(q("/api/tree?showIgnored=1"))).json();
check("showIgnored skips the ignore check", withIgnored.entries.find((e) => e.name === "node_modules")?.ignored === undefined, "flag absent as expected");

const nested = await (await fetch(q(`/api/tree?dir=${encodeURIComponent(`${FIX}/src`)}`))).json();
check("a subdirectory can be listed on demand", nested.entries.some((e) => e.name === "app.ts"), nested.entries.map((e) => e.name).join(", "));

const outsideTree = await fetch(q(`/api/tree?dir=${encodeURIComponent("/etc")}`));
check("listing outside the workspace is refused", outsideTree.status === 403, `status ${outsideTree.status}: ${(await outsideTree.json()).error?.slice(0, 60)}`);

const file = await (await fetch(q(`/api/file?path=${encodeURIComponent("src/app.ts")}`))).json();
check("a text file is read with a language hint", file.text?.includes("answer = 42") && file.language === "typescript", `${file.bytes} bytes, ${file.language}`);

const traversal = await fetch(q(`/api/file?path=${encodeURIComponent("../../../etc/hosts")}`));
check("traversal outside the workspace is refused", traversal.status === 403, (await traversal.json()).error?.slice(0, 70));

const symlinked = await fetch(q(`/api/file?path=${encodeURIComponent("escape")}`));
check("a symlink pointing outside is refused", symlinked.status === 403, (await symlinked.json()).error?.slice(0, 80));

const big = await fetch(q(`/api/file?path=${encodeURIComponent("big.txt")}`));
check("oversized files are refused with the limit", big.status === 403 && /limit/.test((await big.json()).error ?? ""), "size guard");

const binary = await fetch(q(`/api/file?path=${encodeURIComponent("blob.bin")}`));
check("binary files are refused", binary.status === 403 && /binary/.test((await binary.json()).error ?? ""), "binary guard");

const browse = await (await fetch(`${BASE}/api/fs?path=${encodeURIComponent(active)}`)).json();
// dirs only, plus symlinks (they may point at a directory); never plain files
check(
	"the folder picker lists directories (and symlinks), never files",
	browse.entries.every((e) => e.type === "dir" || e.type === "symlink") && !browse.entries.some((e) => e.type === "file"),
	`${browse.entries.length} entries: ${browse.entries.map((e) => e.type).join(",")}`,
);
const browseOut = await (await fetch(`${BASE}/api/fs?path=${encodeURIComponent("/etc")}`)).json();
check("the folder picker refuses outside its roots", typeof browseOut === "string" && /outside the browsable roots/.test(browseOut), String(browseOut).slice(0, 70));

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
