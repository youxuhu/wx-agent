<script setup lang="ts">
/**
 * One tool call: name, status, duration, and — when expanded — the input and the output.
 *
 * A card can be built from two sources: live events from the running child (args, streaming
 * output, end result) or the conversation history (the assistant's `toolCall` arguments plus the
 * following `toolResult` message, see collectToolRuns). Both are shown the same way; when a
 * history call has no result we say so instead of inventing an empty output.
 */
import { computed, ref } from "vue";
import type { ToolRun } from "../types.ts";

const props = defineProps<{ run?: ToolRun; fallbackName?: string }>();
const open = ref(false);

const name = computed(() => props.run?.toolName ?? props.fallbackName ?? "tool");
/**
 * Without a live run record we have no status at all — after a reload the run cannot be observed
 * anymore, so the card states `unknown` instead of pretending the tool is still running.
 */
const status = computed(() => props.run?.status ?? "unknown");
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

/** Keep the tail (that is where an error usually is) and state what was dropped. */
const LIMIT = 20_000;
function clamp(text: string): string {
	if (text.length <= LIMIT) return text;
	return `${text.slice(-LIMIT)}`;
}
function dropped(text: string): string {
	return text.length <= LIMIT ? "" : `${text.length - LIMIT} earlier characters not shown`;
}

const inputText = computed(() => {
	const args = props.run?.args;
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return clamp(args);
	try {
		return clamp(JSON.stringify(args, null, 2));
	} catch {
		return clamp(String(args));
	}
});

/** Live output arrives as chunks while the tool runs, then as the final result. */
const outputText = computed(() => clamp(props.run?.output || props.run?.partial || ""));
const outputNote = computed(() => {
	const run = props.run;
	if (run?.output) return dropped(run.output);
	if (run?.partial) return "streaming — partial output";
	if (status.value === "running") return "no output yet";
	if (status.value === "unknown") return "no result recorded for this call";
	return "the tool reported no output";
});
</script>

<template>
	<div class="tool">
		<div class="tool-head" @click="open = !open">
			<span class="caret faint">{{ open ? "▾" : "▸" }}</span>
			<span class="name">{{ name }}</span>
			<span class="chip" :class="status === 'error' ? 'chip-danger' : status === 'running' ? 'chip-warn' : ''">{{ status }}</span>
			<span v-if="duration" class="faint tiny">{{ duration }}</span>
			<span class="dim small ellipsis spacer">{{ summary }}</span>
		</div>
		<div v-if="open" class="tool-body">
			<div class="tool-section">
				<span class="tiny faint">input</span>
				<pre v-if="inputText" class="code-block">{{ inputText }}</pre>
				<pre v-else class="dim">(no arguments reported)</pre>
			</div>
			<div class="tool-section">
				<span class="tiny faint">output</span>
				<pre v-if="outputText" class="code-block">{{ outputText }}</pre>
				<pre v-else class="dim">{{ outputNote }}</pre>
				<span v-if="outputText && outputNote" class="tiny faint">{{ outputNote }}</span>
			</div>
		</div>
	</div>
</template>
