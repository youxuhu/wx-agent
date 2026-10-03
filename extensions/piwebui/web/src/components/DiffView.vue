<script setup lang="ts">
/** Unified diff, coloured per row. Text only — nothing is re-interpreted. */
import { computed } from "vue";

const props = defineProps<{ text: string }>();

const lines = computed(() =>
	props.text.split("\n").map((line) => {
		let kind = "";
		if (line.startsWith("@@")) kind = "diff-hunk";
		else if (line.startsWith("+++") || line.startsWith("---")) kind = "diff-meta";
		else if (/^(diff --git|index |new file|deleted file|rename |similarity |old mode|new mode)/.test(line)) kind = "diff-meta";
		else if (line.startsWith("+")) kind = "diff-add";
		else if (line.startsWith("-")) kind = "diff-del";
		return { kind, line };
	}),
);
</script>

<template>
	<pre class="code-block"><span v-for="(row, index) in lines" :key="index" :class="row.kind">{{ row.line }}
</span></pre>
</template>
