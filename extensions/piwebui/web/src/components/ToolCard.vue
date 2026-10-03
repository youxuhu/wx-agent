<script setup lang="ts">
/** One tool execution: facts only (name, args, status, output), long output collapsed. */
import { computed, ref } from "vue";
import { Button, Collapse, CollapseItem, Space, Tag } from "@pixelium/web-vue";
import type { ToolRun } from "../types.ts";

const props = defineProps<{ run: ToolRun }>();
const expanded = ref(false);

const statusTheme = computed(() => (props.run.status === "error" ? "danger" : props.run.status === "running" ? "warning" : "success"));
const summary = computed(() => {
	const args = props.run.args as Record<string, unknown> | undefined;
	if (!args) return "";
	const first = ["command", "path", "file_path", "pattern", "action", "query"].map((key) => args[key]).find((value) => typeof value === "string");
	return typeof first === "string" ? first.replace(/\s+/g, " ").slice(0, 120) : "";
});
const body = computed(() => props.run.output || props.run.partial || "(no output yet)");
const duration = computed(() => {
	if (!props.run.endedAt) return "";
	return `${((props.run.endedAt - props.run.startedAt) / 1000).toFixed(1)}s`;
});
</script>

<template>
	<div class="tool">
		<div class="tool-head">
			<Tag theme="notice">{{ props.run.toolName }}</Tag>
			<Tag :theme="statusTheme">{{ props.run.status }}</Tag>
			<span v-if="duration" class="dim">{{ duration }}</span>
			<span class="dim ellipsis">{{ summary }}</span>
			<Space>
				<Button size="small" variant="text" @click="expanded = !expanded">{{ expanded ? "hide" : "details" }}</Button>
			</Space>
		</div>
		<Collapse v-if="expanded">
			<CollapseItem title="args"><pre class="pre">{{ JSON.stringify(props.run.args, null, 2) }}</pre></CollapseItem>
			<CollapseItem title="output">
				<pre class="pre">{{ body.length > 4000 ? body.slice(0, 4000) + `\n… truncated (${body.length} chars total)` : body }}</pre>
			</CollapseItem>
		</Collapse>
	</div>
</template>
