/**
 * Preset discovery + loading.
 * Resolution order (first hit wins for load; list is the union):
 *   1. $PI_PRESETS_DIR
 *   2. ~/.pi/agent/presets            (user overrides)
 *   3. <extension source dir>/templates
 *   4. ~/.pi/agent/extensions/agent-presets/templates
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parsePreset, type Preset } from "./model.ts";

export function presetDirs(): string[] {
	const dirs: string[] = [];
	const envDir = process.env.PI_PRESETS_DIR;
	if (envDir) dirs.push(envDir);
	dirs.push(join(homedir(), ".pi", "agent", "presets"));
	try {
		const metaUrl = import.meta?.url;
		if (typeof metaUrl === "string" && metaUrl) dirs.push(join(dirname(fileURLToPath(metaUrl)), "templates"));
	} catch {
		/* import.meta unavailable after a CJS transform — the fallback below covers it */
	}
	dirs.push(join(homedir(), ".pi", "agent", "extensions", "agent-presets", "templates"));
	return [...new Set(dirs)];
}

export function listPresetNames(): string[] {
	const names = new Set<string>();
	for (const dir of presetDirs()) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) if (f.endsWith(".json")) names.add(f.slice(0, -5));
	}
	return [...names].sort();
}

export function presetPath(name: string): string | null {
	const safe = name.replace(/[^\w.-]/g, "_");
	for (const dir of presetDirs()) {
		const p = join(dir, `${safe}.json`);
		if (existsSync(p)) return p;
	}
	return null;
}

export function loadPreset(name: string): Preset {
	const path = presetPath(name);
	if (!path) throw new Error(`unknown preset "${name}"; available: ${listPresetNames().join(", ") || "(none)"}`);
	return parsePreset(JSON.parse(readFileSync(path, "utf8")), `preset ${name}`);
}

/** Load every preset that parses; broken files are reported as facts, not thrown. */
export function loadAllPresets(): { presets: Preset[]; errors: string[] } {
	const presets: Preset[] = [];
	const errors: string[] = [];
	for (const name of listPresetNames()) {
		try {
			presets.push(loadPreset(name));
		} catch (e) {
			errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { presets, errors };
}
