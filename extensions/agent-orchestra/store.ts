/**
 * Pipeline persistence: ~/.pi/agent/orchestrations/*.json (global)
 * and <repo>/.pi/orchestrations/*.json (project-level, when cwd is a git repo).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parsePipeline, type Pipeline } from "./model.ts";

/**
 * Builtin templates shipped inside the extension directory (read-only baseline).
 * Resolution is defensive: `import.meta.url` is not always available after a
 * CJS transform, so the canonical user-extension location is the fallback.
 */
export function templateDirs(): string[] {
	const dirs: string[] = [];
	const envDir = process.env.PI_ORCHESTRA_TEMPLATES;
	if (envDir) dirs.push(envDir);
	try {
		const metaUrl = import.meta?.url;
		if (typeof metaUrl === "string" && metaUrl) dirs.push(join(dirname(fileURLToPath(metaUrl)), "templates"));
	} catch {
		/* import.meta unavailable in this transform — use the fallbacks below */
	}
	dirs.push(join(homedir(), ".pi", "agent", "extensions", "agent-orchestra", "templates"));
	return [...new Set(dirs)];
}

export function templateDir(): string {
	const dirs = templateDirs();
	for (const d of dirs) if (existsSync(d)) return d;
	return dirs[dirs.length - 1];
}

export function listTemplates(): string[] {
	const names = new Set<string>();
	for (const dir of templateDirs()) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) if (f.endsWith(".json")) names.add(f.slice(0, -5));
	}
	return [...names].sort();
}

export function loadTemplate(name: string): Pipeline | null {
	const safe = name.replace(/[^\w.-]/g, "_");
	for (const dir of templateDirs()) {
		const path = join(dir, `${safe}.json`);
		if (existsSync(path)) return parsePipeline(JSON.parse(readFileSync(path, "utf8")));
	}
	return null;
}

export function globalDir(): string {
	return join(homedir(), ".pi", "agent", "orchestrations");
}

export function projectDir(cwd: string): string | null {
	let dir = cwd;
	for (let i = 0; i < 20; i++) {
		if (existsSync(join(dir, ".git"))) return join(dir, ".pi", "orchestrations");
		const parent = join(dir, "..");
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

export function listPipelines(cwd: string): { name: string; scope: "global" | "project" | "template" }[] {
	const out: { name: string; scope: "global" | "project" | "template" }[] = [];
	const scan = (dir: string, scope: "global" | "project") => {
		if (!existsSync(dir)) return;
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".json")) out.push({ name: f.slice(0, -5), scope });
		}
	};
	scan(globalDir(), "global");
	const pd = projectDir(cwd);
	if (pd) scan(pd, "project");
	for (const t of listTemplates()) {
		if (!out.some((e) => e.name === t)) out.push({ name: t, scope: "template" });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pathFor(name: string, cwd: string): { path: string; scope: "global" | "project" } | null {
	const safe = name.replace(/[^\w.-]/g, "_");
	const pd = projectDir(cwd);
	if (pd && existsSync(join(pd, `${safe}.json`))) return { path: join(pd, `${safe}.json`), scope: "project" };
	const g = join(globalDir(), `${safe}.json`);
	if (existsSync(g)) return { path: g, scope: "global" };
	return null;
}

export function loadPipeline(name: string, cwd: string): Pipeline | null {
	const hit = pathFor(name, cwd);
	if (!hit) return loadTemplate(name); // templates are the last fallback
	return parsePipeline(JSON.parse(readFileSync(hit.path, "utf8")));
}

export function savePipeline(pipeline: Pipeline, cwd: string, scope: "global" | "project" = "global"): string {
	const safe = pipeline.name.replace(/[^\w.-]/g, "_");
	const dir = scope === "project" ? projectDir(cwd) : globalDir();
	if (!dir) throw new Error("save: no project git repo found for project scope");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${safe}.json`);
	writeFileSync(path, JSON.stringify(pipeline, null, 2) + "\n");
	return path;
}

export function deletePipeline(name: string, cwd: string): boolean {
	const hit = pathFor(name, cwd);
	if (!hit) return false;
	unlinkSync(hit.path);
	return true;
}
