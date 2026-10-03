/**
 * Build everything the desktop app ships: our server (single ESM file), the web bundle, the pi
 * runtime subset, and the Node binary. Curated on purpose — the full pi install is 157MB, the
 * subset that the CLI actually needs at runtime is ~70MB (dist + jiti + typebox + @earendil-works
 * + the two native/wasm helpers), and Node itself is ~110MB.
 *
 * Usage: node scripts/desktop-prepare.mjs [--skip-node]
 */
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const resources = join(root, "desktop", "resources");
const NODE_VERSION = process.env.NODE_VERSION ?? process.version; // must satisfy pi's >=22.19
const skipNode = process.argv.includes("--skip-node");

/** Prefer the local devDependency; fall back to the copy inside the pi install. */
const ESBUILD_CANDIDATES = [
	join(root, "node_modules", ".bin", "esbuild"),
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/darwin-arm64/bin/esbuild",
];
const PI_PACKAGE = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";

/** Packages the bundled pi CLI still reaches for at runtime (verified by scripts/desktop-verify). */
const PI_RUNTIME_DEPS = ["jiti", "typebox", "@earendil-works", "@silvia-odwyer", "quickjs-wasi"];

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function run(command, args, options = {}) {
	return new Promise((done, fail) => {
		execFile(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
			if (error) fail(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
			else done(stdout);
		});
	});
}

async function prepareResources() {
	await rm(resources, { recursive: true, force: true });
	await mkdir(resources, { recursive: true });

	// 1. web bundle (already built by `npm run build`)
	await run("npm", ["run", "build"], { cwd: root });
	await cp(join(root, "dist"), join(resources, "dist"), { recursive: true });

	// 2. our server as one ESM file (ws is bundled; nothing else is external)
	const esbuild = ESBUILD_CANDIDATES.find(async (candidate) => await exists(candidate));
	let esbuildBin = ESBUILD_CANDIDATES[0];
	for (const candidate of ESBUILD_CANDIDATES) {
		if (await exists(candidate)) {
			esbuildBin = candidate;
			break;
		}
	}
	void esbuild;
	// `ws` is CommonJS and uses dynamic requires, which an ESM bundle cannot wrap: keep it
	// external and ship the package next to the bundle (Node resolves it from there).
	await run(esbuildBin, [
		"server/main.ts",
		"--bundle",
		"--format=esm",
		"--platform=node",
		"--target=node22",
		"--external:ws",
		`--outfile=${join(resources, "server.mjs")}`,
	]);
	await mkdir(join(resources, "node_modules"), { recursive: true });
	await cp(join(root, "node_modules", "ws"), join(resources, "node_modules", "ws"), { recursive: true });

	// 3. pi runtime subset
	const pi = join(resources, "pi");
	await mkdir(join(pi, "dist"), { recursive: true });
	await cp(join(PI_PACKAGE, "dist"), join(pi, "dist"), { recursive: true });
	await cp(join(PI_PACKAGE, "package.json"), join(pi, "package.json"));
	await mkdir(join(pi, "node_modules"), { recursive: true });
	for (const dependency of PI_RUNTIME_DEPS) {
		const from = join(PI_PACKAGE, "node_modules", dependency);
		if (!(await exists(from))) {
			console.warn(`[prepare] pi dependency missing, skipped: ${dependency}`);
			continue;
		}
		await cp(from, join(pi, "node_modules", dependency), { recursive: true });
	}

	// 4. Node binary (only `bin/node`; npm and the headers are dead weight in an app bundle)
	if (!skipNode) {
		const platform = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
		const archive = `node-v${NODE_VERSION.replace(/^v/, "")}-${platform}.tar.gz`;
		const url = `https://nodejs.org/dist/v${NODE_VERSION.replace(/^v/, "")}/${archive}`;
		if (!(await exists(join(resources, "node")))) {
			console.log(`[prepare] downloading ${url}`);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`node download failed: HTTP ${response.status}`);
			const tarball = join(resources, archive);
			await pipeline(response.body, createWriteStream(tarball));
			await run("tar", ["-xzf", tarball, "-C", resources]);
			const extracted = join(resources, `node-v${NODE_VERSION.replace(/^v/, "")}-${platform}`, "bin", "node");
			await cp(extracted, join(resources, "node"));
			await rm(join(resources, `node-v${NODE_VERSION.replace(/^v/, "")}-${platform}`), { recursive: true, force: true });
			await rm(tarball, { force: true });
		}
		await chmod(join(resources, "node"), 0o755);
	}

	const version = await run(join(resources, "node"), ["--version"]).catch(() => "unknown\n");
	await writeFile(
		join(resources, "MANIFEST.json"),
		JSON.stringify({ node: version.trim(), pi: PI_PACKAGE, runtimeDeps: PI_RUNTIME_DEPS, builtAt: new Date().toISOString() }, null, 2),
	);
	console.log(`[prepare] resources ready at ${resources}`);
}

await prepareResources();
