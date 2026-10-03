/**
 * Git panel acceptance: real repository, real refusals. Also asserts statically that the
 * module has no argv path for force-push/merge/reset/clean.
 */
import { WebSocket } from "ws";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://127.0.0.1:7799";
const REPO = process.env.REPO ?? "/tmp/piwebui-gitrepo";
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (args) =>
	new Promise((resolve) => {
		execFile("git", ["-c", "core.quotepath=false", ...args], { cwd: REPO, encoding: "utf8" }, (error, stdout, stderr) =>
			resolve({ code: error ? 1 : 0, stdout, stderr }),
		);
	});

function connect() {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(BASE.replace("http", "ws") + "/ws");
		const messages = [];
		socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		socket.on("open", () => resolve({ socket, messages, send: (m) => socket.send(JSON.stringify(m)) }));
		socket.on("error", reject);
	});
}

const api = async (action, options = {}) => {
	const url = `${BASE}/api/git/${action}?ws=${encodeURIComponent(options.ws)}${options.query ?? ""}`;
	if (!options.method) return (await fetch(url)).json();
	const response = await fetch(url, {
		method: options.method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(options.body ?? {}),
	});
	return { status: response.status, ...(await response.json()) };
};

// --- fixture -----------------------------------------------------------------
await rm(REPO, { recursive: true, force: true });
await new Promise((resolve) => execFile("mkdir", ["-p", REPO], () => resolve()));
await git(["init", "-q", "-b", "main"]);
await git(["config", "user.email", "probe@example.invalid"]);
await git(["config", "user.name", "probe"]);
await writeFile(`${REPO}/f.txt`, "one\n");
await writeFile(`${REPO}/other.txt`, "base\n");
await git(["add", "."]);
await git(["commit", "-q", "-m", "first"]);

const { socket, messages, send } = await connect();
send({ type: "switch_workspace", path: REPO });
await wait(1500);
const ws = REPO; // realpath of /tmp/... is /private/tmp/... — ask the service which one it used
const health = await (await fetch(`${BASE}/api/health`)).json();
const active = health.active;
check("workspace switched to the fixture repository", Boolean(active), String(active));

// --- read side ---------------------------------------------------------------
let status = await api("status", { ws: active });
check("status reports a repository on branch main", status.repo === true && status.branch === "main" && status.entries.length === 0, `branch=${status.branch} entries=${status.entries.length}`);

await writeFile(`${REPO}/f.txt`, "two\n");
await writeFile(`${REPO}/new.txt`, "untracked\n");
status = await api("status", { ws: active });
const changed = status.entries.find((e) => e.path === "f.txt");
const untracked = status.entries.find((e) => e.path === "new.txt");
check("status classifies modified vs untracked", changed?.worktree === "M" && changed.unstaged === true && untracked?.untracked === true, JSON.stringify({ changed: changed && [changed.index, changed.worktree], untracked: untracked?.kind }));

const workDiff = await api("diff", { ws: active, query: "&path=f.txt" });
check("diff shows the worktree change", workDiff.ok === true && workDiff.stdout.includes("-one") && workDiff.stdout.includes("+two"), workDiff.ok ? "unified diff present" : workDiff.stderr);
const stat = await api("numstat", { ws: active });
check("numstat reports added/deleted per file", stat["f.txt"]?.added === 1 && stat["f.txt"]?.deleted === 1, JSON.stringify(stat["f.txt"]));

// --- stage / commit ----------------------------------------------------------
const staged = await api("stage", { ws: active, method: "POST", body: { paths: ["f.txt"] } });
status = await api("status", { ws: active });
const stagedEntry = status.entries.find((e) => e.path === "f.txt");
check("stage moves the change into the index", staged.ok === true && stagedEntry?.index === "M" && stagedEntry.staged === true, `index=${stagedEntry?.index} worktree=${stagedEntry?.worktree}`);

const committed = await api("commit", { ws: active, method: "POST", body: { message: "second" } });
status = await api("status", { ws: active });
check("commit creates a commit and leaves the tracked tree clean", committed.ok === true && status.entries.filter((e) => e.path === "f.txt").length === 0, committed.ok ? committed.verbatim.split("\n")[0] : committed.verbatim);

const log = await api("log", { ws: active, query: "&limit=5" });
check("log lists commits newest first", log.commits?.length === 2 && log.commits[0].subject === "second", log.commits?.map((c) => c.subject).join(" | "));

// --- branches ----------------------------------------------------------------
const created = await api("branch", { ws: active, method: "POST", body: { name: "feature-x" } });
const branches = await api("branches", { ws: active });
check("create branch checks it out", created.ok === true && branches.branches.some((b) => b.name === "feature-x"), branches.branches.map((b) => b.name).join(", "));

await writeFile(`${REPO}/f.txt`, "dirty\n");
const dirtyCheckout = await api("checkout", { ws: active, method: "POST", body: { branch: "main" } });
check("checkout is refused while the tree is dirty", dirtyCheckout.ok === false && /uncommitted changes/.test(dirtyCheckout.verbatim), dirtyCheckout.verbatim.slice(0, 90));

const unknownCheckout = await api("checkout", { ws: active, method: "POST", body: { branch: "does-not-exist" } });
check("checkout of an unknown branch is refused", unknownCheckout.ok === false && /not a local or remote branch/.test(unknownCheckout.verbatim), unknownCheckout.verbatim.slice(0, 80));

// --- discard + snapshot ------------------------------------------------------
const unconfirmed = await api("discard", { ws: active, method: "POST", body: { paths: ["f.txt"] } });
check("discard without confirmation is refused", unconfirmed.ok === false && /confirmed:true/.test(unconfirmed.verbatim), unconfirmed.verbatim.slice(0, 80));

const confirmed = await api("discard", { ws: active, method: "POST", body: { paths: ["f.txt"], confirmed: true } });
const restored = await readFile(`${REPO}/f.txt`, "utf8");
check("discard restores the file and reports a snapshot ref", confirmed.ok === true && restored === "two\n" && /refs\/piwebui\//.test(confirmed.snapshot?.detail ?? ""), `${JSON.stringify(restored)} ${confirmed.snapshot?.detail ?? ""}`);
const snapshotExists = confirmed.snapshot?.ref ? await new Promise((resolve) => execFile("git", ["rev-parse", "--verify", confirmed.snapshot.ref], { cwd: REPO }, (error, stdout) => resolve(!error && Boolean(stdout.trim())))) : false;
check("the snapshot ref really exists in the repository", snapshotExists === true, String(confirmed.snapshot?.ref));

const untrackedDiscard = await api("discard", { ws: active, method: "POST", body: { paths: ["new.txt"], confirmed: true } });
check("discard refuses untracked files", untrackedDiscard.ok === false && /untracked/.test(untrackedDiscard.verbatim), untrackedDiscard.verbatim.slice(0, 90));

const outside = await api("diff", { ws: active, query: "&path=../../../etc/hosts" });
check("paths outside the repository are refused", outside.ok === false && /outside/.test(outside.stderr), outside.stderr.slice(0, 80));

// --- conflicts ---------------------------------------------------------------
await git(["checkout", "-q", "main"]);
await writeFile(`${REPO}/conflict.txt`, "base\n");
await git(["add", "conflict.txt"]);
await git(["commit", "-q", "-m", "base for conflict"]);
await git(["checkout", "-q", "-b", "side"]);
await writeFile(`${REPO}/conflict.txt`, "side\n");
await git(["commit", "-q", "-am", "side change"]);
await git(["checkout", "-q", "main"]);
await writeFile(`${REPO}/conflict.txt`, "main\n");
await git(["commit", "-q", "-am", "main change"]);
await git(["merge", "side"]); // expected to conflict
const conflictStatus = await api("status", { ws: active });
const conflicted = conflictStatus.entries.find((e) => e.conflicted === true);
check("a merge conflict shows up as an unmerged entry", Boolean(conflicted), JSON.stringify(conflictStatus.entries.map((e) => [e.path, e.index + e.worktree])));
await git(["merge", "--abort"]);

// --- static invariants -------------------------------------------------------
const source = await readFile(new URL("../server/git.ts", import.meta.url), "utf8");
const forbidden = ["push", "reset", "clean", "merge", "rebase", "filter-branch"].filter((word) =>
	new RegExp(`\\[\\s*"${word}"`, "i").test(source) || new RegExp(`"${word}",\\s*"`).test(source),
);
check("no argv path for push/reset/clean/merge/rebase", forbidden.length === 0, forbidden.length ? `found: ${forbidden.join(", ")}` : "none");
check("force flags never appear", !/--force|-f",/.test(source), /--force/.test(source) ? "--force present" : "none");

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
