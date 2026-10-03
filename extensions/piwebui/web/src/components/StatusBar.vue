<script setup lang="ts">
/**
 * Status bar: the same numbers the terminal footer shows, assembled from what pi reported.
 *
 * Sources (all facts, nothing invented):
 *  - `usage` on `message_update` / `turn_end` → ↑in ↓out R(cache read) W(cache write) $cost
 *  - `get_session_stats.contextUsage` → percent / context window
 *  - `setStatus` extension records → policy mode, git branch, LSP state, sandbox state…
 *  - output tokens per second is measured here from consecutive usage reports of a run
 *    (same definition as the terminal speed footer: output tokens ÷ elapsed seconds).
 */
import { computed } from "vue";
import { Tag, Tooltip } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();

const fmtTokens = (n: number): string => {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
};

/**
 * Session totals come from `get_session_stats` (what the terminal footer shows); the live
 * per-message usage is the fallback until the first stats response arrives.
 */
const totals = computed(() => {
	const tokens = store.stats?.tokens;
	if (tokens && (tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite)) {
		return {
			input: tokens.input ?? 0,
			output: tokens.output ?? 0,
			cacheRead: tokens.cacheRead ?? 0,
			cacheWrite: tokens.cacheWrite ?? 0,
			cost: Number(store.stats?.cost ?? 0),
			source: "session",
		};
	}
	if (!store.usage) return null;
	return { ...store.usage, source: "live" };
});

const cacheHitRate = computed(() => {
	const value = totals.value;
	if (!value) return null;
	const prompt = value.input + value.cacheRead + value.cacheWrite;
	if (value.cacheRead <= 0 && value.cacheWrite <= 0) return null;
	if (prompt <= 0) return null;
	return (value.cacheRead / prompt) * 100;
});

const contextPercent = computed(() => store.contextUsage?.percent ?? null);
const contextTheme = computed(() => {
	const percent = contextPercent.value;
	if (percent === null) return "notice";
	if (percent > 90) return "danger";
	if (percent > 70) return "warning";
	return "success";
});

/** Extension statuses, keys kept so a value is always traceable to its setter. */
const statuses = computed(() => Object.entries(store.status).filter(([, value]) => value && value.trim().length > 0));
</script>

<template>
	<div class="bar">
		<Tooltip :content="totals ? `token totals (${totals.source})` : 'no usage reported yet'">
			<span class="seg mono">
				<template v-if="totals">
					<span v-if="totals.input">↑{{ fmtTokens(totals.input) }}</span>
					<span v-if="totals.output">↓{{ fmtTokens(totals.output) }}</span>
					<span v-if="totals.cacheRead">R{{ fmtTokens(totals.cacheRead) }}</span>
					<span v-if="totals.cacheWrite">W{{ fmtTokens(totals.cacheWrite) }}</span>
					<span v-if="cacheHitRate !== null">CH{{ cacheHitRate.toFixed(1) }}%</span>
					<span v-if="totals.cost">${{ totals.cost.toFixed(3) }}</span>
				</template>
				<span v-else class="dim">no usage yet</span>
			</span>
		</Tooltip>

		<span v-if="store.speed !== null" class="seg mono">{{ Math.round(store.speed) }} t/s</span>

		<Tooltip content="context usage / window, as estimated by pi (get_session_stats.contextUsage)">
			<Tag size="small" :theme="contextTheme">
				<template v-if="contextPercent !== null">
					{{ contextPercent.toFixed(1) }}%/{{ store.contextUsage?.contextWindow ? fmtTokens(store.contextUsage.contextWindow) : "?" }}
				</template>
				<template v-else>context: ?</template>
			</Tag>
		</Tooltip>
		<span class="seg statuses">
			<Tooltip v-for="[key, value] in statuses" :key="key" :content="`setStatus(${key})`">
				<span class="status mono">{{ value }}</span>
			</Tooltip>
		</span>

		<span class="seg right mono">
			<span>{{ store.model || "no-model" }}</span>
			<span v-if="store.thinkingLevel">• {{ store.thinkingLevel }}</span>
			<span v-if="store.queueSteering || store.queueFollowUp" class="dim">
				queue {{ store.queueSteering }}/{{ store.queueFollowUp }}
			</span>
		</span>
	</div>
</template>

<style scoped>
.bar {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	border-top: 1px solid var(--px-neutral-5, #ddd);
	padding: 2px 0;
	font-size: 12px;
}

.seg {
	display: inline-flex;
	gap: 8px;
	align-items: center;
}

.mono {
	font-family: var(--px-font, monospace);
}

.statuses {
	flex: 1;
	min-width: 0;
	flex-wrap: wrap;
}

.status {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 32vw;
}

.right {
	margin-left: auto;
}

.dim {
	color: var(--px-neutral-8, #666);
}
</style>
