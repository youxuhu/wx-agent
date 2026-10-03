<script setup lang="ts">
/** One tool call: name, status, duration, argument summary; output collapses. */
import { computed, ref } from "vue";
import type { ToolRun } from "../types.ts";

const props = defineProps<{ run?: ToolRun; fallbackName?: string }>();
const open = ref(false);

const name = computed(() => props.run?.name ?? props.fallbackName ?? "tool");
const status = computed(() => props.run?.status ?? "running");
const duration = computed(() => {
	const run = props.run;
	if (!run?.endedAt || !run.startedAt) return "";
	return `${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s`;
});
const summary = computed(() => {
	const args = props.run?.args as Record<string, unknown> | undefined;
	if (!args) return "";
	const first = Object.entries(args).find(([, value]) => typeof value === "string" && value.length > 0);
	if (!first) return "";
	const text = String(first[1]).replace(/\s+/g, " ");
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
});
const output = computed(() => props.run?.output ?? "");
</script>

<template>
	<div class="tool">
		<div class="tool-head" @click="open = !open">
			<span class="caret faint">{{ open ? "▾" : "▸" }}</span>
			<span class="name">{{ name }}</span>
			<span class="chip" :class="status === 'error' ? 'chip-danger' : status === 'done' ? '' : 'chip-warn'">{{ status }}</span>
			<span v-if="duration" class="faint tiny">{{ duration }}</span>
			<span class="dim small ellipsis spacer">{{ summary }}</span>
		</div>
		<div v-if="open" class="tool-body">
			<pre v-if="output" class="code-block">{{ output.slice(-20000) }}</pre>
			<pre v-else class="dim">(no output reported)</pre>
		</div>
	</div>
</template>
