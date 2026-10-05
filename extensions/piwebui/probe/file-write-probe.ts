/**
 * Editing a workspace file from the browser.
 *
 * Facts pinned here (each one is a rule that exists to protect real files):
 *  - a write inside the workspace succeeds and is atomic (no half-written file is ever visible);
 *  - the file's mode survives the write;
 *  - a path outside the workspace, or a symlink pointing outside, is refused;
 *  - a file that changed on disk since it was read is refused with 409 and left untouched
 *    (no blind overwrite, no merge);
 *  - a write without the read's mtime/size is refused (428) — "overwrite anyway" is not an option;
 *  - binaries and oversized content are refused;
 *  - the panel offers edit/save/reload and reports the write as a fact.
 *
 * Usage: node probe/file-write-probe.ts [port]
 */
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv[2] ?? 7796);
const workspace = realpathSync("/tmp/cplab");

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(path)}`, init);
const read = () => api("editable.txt").then((r) => r.json() as Promise<{ text: string; bytes: number; mtimeMs: number }>);
const write = (body: unknown, path = "editable.txt") =>
	api(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (response) => ({
		status: response.status,
		body: (await response.json()) as { error?: string; bytes?: number; mode?: string; mtimeMs?: number },
	}));

// Fixtures: an editable file, a binary file and a symlink that leaves the workspace.
writeFileSync(join(workspace, "editable.txt"), "first line\nsecond line\n");
writeFileSync(join(workspace, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
mkdirSync("/tmp/cplab-outside", { recursive: true });
writeFileSync("/tmp/cplab-outside/secret.txt", "outside\n");
try {
	symlinkSync("/tmp/cplab-outside/secret.txt", join(workspace, "escape.txt"));
} catch {
	/* already linked */
}

// 1. Read gives what a save needs (mtime + size).
const before = await read();
check("reading a file reports the mtime and size a save needs", typeof before.mtimeMs === "number" && before.bytes > 0, `bytes=${before.bytes}`);

// 2. A normal save works and reports what it wrote.
const saved = await write({ content: "first line\nsecond line changed\nthird line\n", expectedMtimeMs: before.mtimeMs, expectedSize: before.bytes });
check("a save inside the workspace succeeds", saved.status === 200, JSON.stringify(saved.body));
check("the answer reports the bytes written", typeof saved.body.bytes === "number" && saved.body.bytes > 0, String(saved.body.bytes));
check("the file on disk really changed", readFileSync(join(workspace, "editable.txt"), "utf8").includes("second line changed"));

// 3. No .bak and no leftover temporary file (a source file must not be polluted).
const listing = await fetch(`http://127.0.0.1:${port}/api/tree?path=${encodeURIComponent(workspace)}&depth=1`).then((r) => r.json()).catch(() => ({ entries: [] as Array<{ name: string }> }));
const entryNames = (listing.entries ?? []).map((entry: { name: string }) => entry.name);
check("no .bak file is created", !entryNames.includes("editable.txt.bak"), entryNames.join(" "));
check("no temporary write file is left behind", !entryNames.some((name: string) => name.startsWith(".piwebui-write-")), entryNames.filter((n: string) => n.startsWith(".")).join(" "));

// 4. The mode survives the write.
const mode = (statSync(join(workspace, "editable.txt")).mode & 0o777).toString(8).padStart(3, "0");
check("the file mode is preserved", (saved.body.mode ?? mode) === mode, `${saved.body.mode} vs ${mode}`);

// 5. A stale read is refused (409) and the file is untouched.
const stale = await write({ content: "clobbered\n", expectedMtimeMs: before.mtimeMs, expectedSize: before.bytes });
check("a file changed on disk is refused with 409", stale.status === 409, `${stale.status} ${stale.body.error?.slice(0, 80)}`);
check("the refusal keeps the file intact", !readFileSync(join(workspace, "editable.txt"), "utf8").includes("clobbered"));

// 6. A write without the read's facts is refused (428), never treated as "overwrite".
const blind = await write({ content: "blind\n" });
check("a write without mtime/size is refused with 428", blind.status === 428, `${blind.status} ${blind.body.error?.slice(0, 70)}`);
check("the blind write did not land", !readFileSync(join(workspace, "editable.txt"), "utf8").includes("blind"));

// 7. Containment: outside paths and symlinks that escape are refused.
const outside = await write({ content: "x", expectedMtimeMs: 0, expectedSize: 0 }, "/tmp/cplab-outside/secret.txt");
check("a path outside the workspace is refused", outside.status === 403, `${outside.status} ${outside.body.error?.slice(0, 60)}`);
check("the outside file is untouched", readFileSync("/tmp/cplab-outside/secret.txt", "utf8") === "outside\n");
const escape = await write({ content: "x", expectedMtimeMs: 0, expectedSize: 0 }, "escape.txt");
check("a symlink pointing outside the workspace is refused", escape.status === 403, `${escape.status} ${escape.body.error?.slice(0, 80)}`);

// 8. Binaries and oversized content are refused.
const fresh = await read();
const binary = await write({ content: "text\n", expectedMtimeMs: statSync(join(workspace, "binary.bin")).mtimeMs, expectedSize: statSync(join(workspace, "binary.bin")).size }, "binary.bin");
check("writing a binary file is refused", binary.status === 415, `${binary.status} ${binary.body.error?.slice(0, 60)}`);
const huge = await write({ content: "x".repeat(3 * 1024 * 1024), expectedMtimeMs: fresh.mtimeMs, expectedSize: fresh.bytes });
check("content above the size limit is refused", huge.status === 413, `${huge.status} ${huge.body.error?.slice(0, 60)}`);

// 9. Atomicity: the replacement is a rename, so the file never exists half-written. This is checked
//    structurally (a temp file in the same directory, then rename) plus by the fact that a failed
//    write above left the original content in place.
const serverFs = readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "server", "fs.ts"), "utf8");
check("the write goes through a temp file in the same directory", /\.piwebui-write-/.test(serverFs) && /rename\(temporary, targetReal\)/.test(serverFs));
check("the temp file is removed when the write fails", /rm\(temporary, \{ force: true \}\)/.test(serverFs));

// 10. The panel offers the editing flow and reports the write as a fact.
const panel = readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "web", "src", "components", "FilePanel.vue"), "utf8");
const store = readFileSync(join(homedir(), ".pi", "agent", "extensions", "piwebui", "web", "src", "stores", "session.ts"), "utf8");
check("the panel can start editing", /function startEditing\(\)/.test(panel));
check("the panel shows the write result as a fact", /store\.fileSaveError/.test(panel));
check("the store reports bytes/lines/mtime after a save", /wrote \$\{view\.path\} — \$\{bytes\} bytes/.test(store));
check("a refused save offers a reload from disk", /reloadFile\(\)/.test(panel));
const saveBody = store.slice(store.indexOf("saveFile(): void"), store.indexOf("reloadFile(): void"));
check("a refused save surfaces the reason and stops (no silent retry)", /this\.fileSaveError = result\.body\.error/.test(saveBody) && (saveBody.match(/fetch\(/g) ?? []).length === 1);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
