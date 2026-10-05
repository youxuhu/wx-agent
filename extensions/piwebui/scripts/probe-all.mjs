/**
 * Run every acceptance probe, with the fixtures each one needs.
 *
 * Why this exists: the probes need ad-hoc rigs (test agent dirs, a preview fixture, a throwaway
 * auth copy, a test git repo) and a couple of them only pass against a freshly started service.
 * Doing that by hand was error-prone and got done differently every time; this script is the
 * single source of truth for the rig, and the probe matrix in MAINTENANCE.md references it.
 *
 * Usage:
 *   node scripts/probe-all.mjs            # everything
 *   node scripts/probe-all.mjs --only=pty,scroll
 *   node scripts/probe-all.mjs --keep     # leave the rigs running (for manual follow-up)
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const agentDirReal = join(homedir(), ".pi", "agent");
const only = process.argv.find((value) => value.startsWith("--only="))?.slice(7).split(",").filter(Boolean) ?? null;
const keep = process.argv.includes("--keep");

const RIG = {
	testAgent: "/tmp/piwebui-testagent",
	authAgent: "/tmp/piwebui-authtest",
	previewRoot: "/tmp/piwebui-preview",
	gitLab: "/tmp/cplab",
	checkpointLab: "/tmp/cplab",
	scrollAgent: "/tmp/scrolllab-agent",
	workspace: "/Users/revy/project/minepi",
};

const services = [];

function startService(name, port, args, env = {}) {
	const child = spawn(process.execPath, [join(extensionRoot, "server", "main.ts"), "--port", String(port), "--host", "127.0.0.1", "--no-remember", ...args], {
		cwd: extensionRoot,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	services.push({ name, port, child });
	return child;
}

async function waitForHealth(port, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

function runProbe(file, args = [], env = {}) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [join(extensionRoot, "probe", file), ...args], {
			cwd: extensionRoot,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => (out += String(chunk)));
		child.stderr.on("data", (chunk) => (err += String(chunk)));
		child.on("close", (code) => {
			const summary = out.trim().split("\n").filter((line) => /passed|checks passed/.test(line)).at(-1) ?? out.trim().split("\n").at(-1) ?? "";
			const failures = out.split("\n").filter((line) => line.startsWith("FAIL")).slice(0, 3);
			resolveRun({ file, code, summary: summary.trim(), failures, err: err.slice(-400) });
		});
	});
}

function setupFixtures() {
	// Leftover fixture servers would hold the ports the probes expect: they are ours, so clear them.
	for (const pattern of ["probe/fixtures/preview-server.mjs", "probe/fixtures/ws-server.mjs", "/tmp/ws-upstream.mjs"]) {
		try {
			spawn("pkill", ["-f", pattern], { stdio: "ignore" });
		} catch {
			/* pkill is best effort */
		}
	}
	// A test agent dir that sees the real extensions but owns its config files.
	mkdirSync(RIG.testAgent, { recursive: true });
	const extensionsLink = join(RIG.testAgent, "extensions");
	if (!existsSync(extensionsLink)) symlinkSync(agentDirReal + "/extensions", extensionsLink);
	for (const file of ["auth.json", "models.json", "settings.json"]) {
		const source = join(agentDirReal, file);
		if (existsSync(source)) cpSync(source, join(RIG.testAgent, file));
	}
	// The preview probe asserts exact rewritten URLs (see probe/fixtures/preview-server.mjs).
	mkdirSync(RIG.previewRoot, { recursive: true });
	writeFileSync(join(RIG.previewRoot, "index.html"), "<html><body>static file inside the preview root</body></html>\n");
	writeFileSync(
		join(RIG.testAgent, "preview.json"),
		`${JSON.stringify(
			{
				projects: {
					[RIG.previewRoot]: { command: `node ${join(extensionRoot, "probe/fixtures/preview-server.mjs")} 5199`, port: 5199, root: RIG.previewRoot },
					// The websocket probe runs against the git lab, so that workspace needs an upstream too.
					[realpathSync(RIG.gitLab)]: { command: `node ${join(extensionRoot, "probe/fixtures/ws-server.mjs")} 5188`, port: 5188 },
				},
			},
			null,
			2,
		)}\n`,
	);
	// A throwaway copy, so the auth probe can delete credentials without touching the real file.
	mkdirSync(RIG.authAgent, { recursive: true });
	if (existsSync(join(agentDirReal, "auth.json"))) cpSync(join(agentDirReal, "auth.json"), join(RIG.authAgent, "auth.json"));
	// A git repository with checkpoints fixtures for the rewind probe.
	mkdirSync(RIG.gitLab, { recursive: true });
	if (!existsSync(join(RIG.gitLab, ".git"))) {
		spawn("git", ["init", "-q"], { cwd: RIG.gitLab });
		spawn("git", ["-C", RIG.gitLab, "config", "user.email", "probe@local"]);
		spawn("git", ["-C", RIG.gitLab, "config", "user.name", "probe"]);
		writeFileSync(join(RIG.gitLab, "a.txt"), "one\n");
		spawn("git", ["-C", RIG.gitLab, "add", "-A"]);
		spawn("git", ["-C", RIG.gitLab, "commit", "-qm", "init"]);
	}
	// A git repo with history for the probe that needs a long thread is created by the probes themselves.
	void realpathSync;
}

const OFFLINE = ["scroll", "path", "markdown", "message", "health", "tool", "pty", "session-delete", "no-workspace"];
// `approval-probe` is a manual driver (it needs a model and a policy ask rule), not an assertion probe.
const ON_7801 = ["control", "preview", "disconnect"];
const ON_7802 = ["auth"];
const ON_7799 = ["files", "git", "run-lifecycle"];
const ON_7796 = ["clear-queue", "tab-writer", "preview-ws", "reload", "rewind", "login", "file-write"];

if (!only) keep || process.on("exit", () => {
	for (const service of services) service.child.kill("SIGKILL");
});

console.log("→ preparing the rigs");
setupFixtures();

const results = [];
const should = (name) => !only || only.includes(name);

for (const name of OFFLINE) {
	if (!should(name)) continue;
	results.push(await runProbe(`${name}-probe.ts`));
}

if (ON_7801.some(should)) {
	console.log("→ starting the :7801 rig (preview fixture + test agent dir)");
	startService("7801", 7801, ["--cwd", RIG.previewRoot, "--agent-dir", RIG.testAgent], { PI_CODING_AGENT_DIR: RIG.testAgent });
	if (!(await waitForHealth(7801))) console.log("  ! :7801 did not come up");
	for (const name of ON_7801) if (should(name)) results.push(await runProbe(`${name}-probe.ts`));
}

if (ON_7802.some(should)) {
	console.log("→ starting the :7802 rig (throwaway auth copy)");
	startService("7802", 7802, ["--cwd", RIG.workspace, "--agent-dir", RIG.authAgent], { PI_CODING_AGENT_DIR: RIG.authAgent });
	if (!(await waitForHealth(7802))) console.log("  ! :7802 did not come up");
	for (const name of ON_7802) if (should(name)) results.push(await runProbe(`${name}-probe.ts`));
}

if (ON_7799.some(should)) {
	console.log("→ starting the :7799 rig (workspace registry)");
	startService("7799", 7799, ["--cwd", RIG.workspace]);
	if (!(await waitForHealth(7799))) console.log("  ! :7799 did not come up");
	// This one asserts a registry with exactly one workspace, so it goes first and alone.
	if (should("workspace")) results.push(await runProbe("workspace-probe.ts"));
	for (const name of ON_7799) if (should(name)) results.push(await runProbe(`${name}-probe.ts`));
}

if (ON_7796.some(should)) {
	console.log("→ starting the :7796 rig (extensions + checkpoints + preview upstream)");
	startService("7796", 7796, ["--cwd", RIG.checkpointLab, "--agent-dir", RIG.testAgent, "--model", "deepseek/deepseek-flash"], { PI_CODING_AGENT_DIR: RIG.testAgent });
	if (!(await waitForHealth(7796))) console.log("  ! :7796 did not come up");
	for (const name of ON_7796) {
		if (!should(name)) continue;
		// The rewind probe writes its own index fixture, so it must be told which agent dir to use.
		const args = name === "rewind" ? ["7796", "--agent-dir", RIG.testAgent] : ["7796"];
		results.push(await runProbe(`${name}-probe.ts`, args));
	}
}

if (!keep) for (const service of services) service.child.kill("SIGKILL");

console.log("\n=== probe summary ===");
let failed = 0;
for (const result of results) {
	const ok = result.code === 0;
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${result.file.padEnd(26)} ${result.summary}`);
	for (const line of result.failures) console.log(`       ${line.slice(0, 150)}`);
	if (!ok && !result.failures.length && result.err) console.log(`       ${result.err.split("\n").at(-1)?.slice(0, 150)}`);
}
console.log(`\n${results.length - failed}/${results.length} probe files passed`);
process.exit(failed ? 1 : 0);
