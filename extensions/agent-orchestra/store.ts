/**
 * Pipeline persistence: ~/.pi/agent/orchestrations/*.json (global)
 * and <repo>/.pi/orchestrations/*.json (project-level, when cwd is a git repo).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parsePipeline, type Pipeline } from "./model.ts";

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

export function listPipelines(cwd: string): { name: string; scope: "global" | "project" }[] {
	const out: { name: string; scope: "global" | "project" }[] = [];
	const scan = (dir: string, scope: "global" | "project") => {
		if (!existsSync(dir)) return;
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".json")) out.push({ name: f.slice(0, -5), scope });
		}
	};
	scan(globalDir(), "global");
	const pd = projectDir(cwd);
	if (pd) scan(pd, "project");
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
	if (!hit) return null;
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
