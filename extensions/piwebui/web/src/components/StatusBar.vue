<script setup lang="ts">
/**
 * Footer facts, same numbers as the terminal footer: session tokens/cost, cache hit rate,
 * context usage, extension statuses, model and thinking level.
 */
import { computed } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();

const fmtTokens = (n: number): string => {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
};

const totals = computed(() => {
	const tokens = store.stats?.tokens;
	if (tokens && (tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite)) {
		return { input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0, cost: Number(store.stats?.cost ?? 0), source: "session" };
	}
	if (!store.usage) return null;
	return { ...store.usage, source: "live" };
});

const cacheHitRate = computed(() => {
	const value = totals.value;
	if (!value) return null;
	const prompt = value.input + value.cacheRead + value.cacheWrite;
	if (value.cacheRead <= 0 && value.cacheWrite <= 0) return null;
	return prompt > 0 ? (value.cacheRead / prompt) * 100 : null;
});

const percent = computed(() => store.contextUsage?.percent ?? null);
const contextLabel = computed(() => {
	if (percent.value === null) return "context —";
	const window = store.contextUsage?.contextWindow ?? 0;
	return `context ${percent.value.toFixed(1)}%/${window ? fmtTokens(window) : "?"}`;
});
const statuses = computed(() => Object.entries(store.status).filter(([, value]) => value && value.trim().length > 0));

function fmtClock(ms: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleTimeString();
}
</script>

<template>
	<div class="statusline">
		<span v-if="totals" class="mono tiny">
			<template v-if="totals.input">↑{{ fmtTokens(totals.input) }}</template>
			<template v-if="totals.output"> ↓{{ fmtTokens(totals.output) }}</template>
			<template v-if="totals.cacheRead"> R{{ fmtTokens(totals.cacheRead) }}</template>
			<template v-if="cacheHitRate !== null"> CH{{ cacheHitRate.toFixed(1) }}%</template>
			<template v-if="totals.cost"> ${{ totals.cost.toFixed(3) }}</template>
		</span>
		<span v-else class="tiny faint">no usage yet</span>
		<span v-if="store.speed !== null" class="tiny mono">{{ Math.round(store.speed) }} t/s</span>
		<span class="tiny mono" :class="percent !== null && percent > 80 ? 'err' : ''">{{ contextLabel }}</span>
		<span v-for="[key, value] in statuses" :key="key" class="chip" :title="`setStatus(${key})`">{{ value }}</span>
		<span class="spacer" />
		<span class="tiny faint">{{ store.model || "no model" }}<template v-if="store.thinkingLevel"> · {{ store.thinkingLevel }}</template></span>
		<span class="tiny faint">conn {{ store.conn }}<template v-if="store.reconnectIn"> · retry in {{ store.reconnectIn }}s</template></span>
	</div>
</template>
