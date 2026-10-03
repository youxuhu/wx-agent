<script setup lang="ts">
/** Unified diff with row-level colours. Text only — nothing is re-interpreted. */
import { computed } from "vue";

const props = defineProps<{ text: string }>();

const lines = computed(() =>
	props.text.split("\n").map((line) => {
		let kind = "ctx";
		if (line.startsWith("@@")) kind = "hunk";
		else if (line.startsWith("+++") || line.startsWith("---")) kind = "file";
		else if (/^(diff --git|index |new file|deleted file|rename |similarity |old mode|new mode)/.test(line)) kind = "meta";
		else if (line.startsWith("+")) kind = "add";
		else if (line.startsWith("-")) kind = "del";
		return { kind, line };
	}),
);
</script>

<template>
	<pre class="diff"><span v-for="(row, index) in lines" :key="index" :class="row.kind">{{ row.line }}
</span></pre>
</template>

<style scoped>
.diff {
	margin: 0;
	font-family: var(--px-font, monospace);
	font-size: 12px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: 46vh;
	overflow: auto;
	border: 1px solid var(--px-neutral-5, #ddd);
	padding: 4px;
}

.add {
	color: #15803d;
	background: #f0fdf4;
}

.del {
	color: #b91c1c;
	background: #fef2f2;
}

.hunk {
	color: #6d28d9;
	background: #f5f3ff;
}

.file,
.meta {
	color: #475569;
}

.ctx {
	color: var(--px-neutral-9, #333);
}
</style>
