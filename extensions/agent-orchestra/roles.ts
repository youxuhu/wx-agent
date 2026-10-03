/**
 * Role presets. Preset lanes map to pi-subagents agents; custom agents are
 * enumerated from ~/.pi/agent/agents/*.md (user directory) — never hardcoded
 * beyond the preset table. All names are english.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RolePreset {
	/** lane name shown in the palette (english) */
	name: string;
	/** agent passed to the subagent tool */
	agent: string;
	/** extra subagent params baked into the preset */
	overrides?: Record<string, unknown>;
	description: string;
}

export const PRESET_ROLES: RolePreset[] = [
	{ name: "explore", agent: "scout", description: "read-only codebase recon, fresh context" },
	{ name: "build", agent: "worker", description: "implementation + validation" },
	{
		name: "computeruser",
		agent: "worker",
		overrides: { skill: ["computer-use"] },
		description: "GUI automation via computer-use skill",
	},
	{ name: "review", agent: "reviewer", description: "independent review gate, fresh context" },
	{ name: "advisor", agent: "oracle", description: "second opinion before risky decisions" },
	{ name: "research", agent: "researcher", description: "web/docs research with sources" },
];

/** User-defined agents: ~/.pi/agent/agents/*.md (name = filename without .md). */
export function customAgents(): string[] {
	const dir = join(homedir(), ".pi", "agent", "agents");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => f.slice(0, -3))
		.sort();
}

/** Optional aliases: ~/.pi/agent/orchestrations/roles.json → { alias: agentName } */
export function roleAliases(): Record<string, string> {
	const path = join(homedir(), ".pi", "agent", "orchestrations", "roles.json");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : {};
	} catch {
		return {};
	}
}

export interface PaletteEntry {
	name: string;
	agent: string;
	overrides?: Record<string, unknown>;
	description: string;
}

export function palette(): PaletteEntry[] {
	const entries: PaletteEntry[] = PRESET_ROLES.map((r) => ({ ...r }));
	for (const [alias, agent] of Object.entries(roleAliases())) {
		entries.push({ name: alias, agent, description: `alias → ${agent}` });
	}
	for (const agent of customAgents()) {
		if (!entries.some((e) => e.agent === agent)) {
			entries.push({ name: agent, agent, description: "user agent (~/.pi/agent/agents)" });
		}
	}
	return entries;
}
