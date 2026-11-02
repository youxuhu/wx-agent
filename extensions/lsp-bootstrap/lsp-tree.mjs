/** Language-server tree bookkeeping shared by the extension and the CLI script. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Where the pins live (tracked in git); the installed tree next to it is not. */
export function lspPaths(root) {
	return {
		tree: join(root, "lsp"),
		manifest: join(root, "lsp", "package.json"),
		lock: join(root, "lsp", "package-lock.json"),
		modules: join(root, "lsp", "node_modules"),
		config: join(root, "pi-lsp.json"),
	};
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Pinned versions, straight from the tracked package.json (the single source of truth). */
export function pinned(root) {
	const manifest = readJson(lspPaths(root).manifest);
	const deps = manifest?.dependencies;
	return deps && typeof deps === "object" ? deps : null;
}

/** Versions actually installed in our own tree; null when the package is not there. */
export function installed(root) {
	const pins = pinned(root) ?? {};
	const out = {};
	for (const name of Object.keys(pins)) {
		out[name] = readJson(join(lspPaths(root).modules, name, "package.json"))?.version ?? null;
	}
	return out;
}

/** {name: {want, have}} for everything that does not match the pins. */
export function drift(root) {
	const pins = pinned(root);
	if (!pins) return null;
	const have = installed(root);
	const out = {};
	for (const [name, want] of Object.entries(pins)) {
		if (have[name] !== want) out[name] = { want, have: have[name] ?? null };
	}
	return out;
}

/** Does pi-lsp.json point at this tree already? */
export function configPointsAtTree(root) {
	const config = readJson(lspPaths(root).config);
	if (!config || typeof config !== "object") return false;
	const bin = join(lspPaths(root).tree, "node_modules", ".bin");
	return Object.values(config).every((server) => {
		const command = server?.command;
		return Array.isArray(command) && typeof command[0] === "string" ? command[0].startsWith(bin) : false;
	});
}

/** The machine-local config for this tree (absolute paths, so PATH never decides what runs). */
export function configFor(root) {
	const bin = join(lspPaths(root).tree, "node_modules", ".bin");
	return {
		typescript: {
			command: [join(bin, "typescript-language-server"), "--stdio"],
			extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
		},
		pyright: {
			command: [join(bin, "pyright-langserver"), "--stdio"],
			extensions: [".py", ".pyi"],
		},
	};
}

export function hasPins(root) {
	return Boolean(pinned(root)) && existsSync(lspPaths(root).tree);
}
