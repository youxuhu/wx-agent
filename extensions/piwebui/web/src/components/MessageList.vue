<script setup lang="ts">
/** Codex-style thread: user blocks, assistant text, collapsible thinking and tool rows. */
import type { ChatMessage, ToolRun } from "../types.ts";
import ToolCard from "./ToolCard.vue";

const props = defineProps<{ messages: ChatMessage[]; tools: Record<string, ToolRun> }>();
</script>

<template>
	<div class="thread">
		<div class="thread-inner">
			<div v-if="!props.messages.length" class="dim small">No messages yet — send a prompt below.</div>

			<article v-for="message in props.messages" :key="message.id" :class="message.role === 'user' ? 'msg-user' : 'msg-assistant'">
				<div class="msg-role">{{ message.role === "user" ? "You" : "pi" }}</div>
				<template v-for="(block, index) in message.blocks" :key="index">
					<!-- The block discriminator is `kind` (see Block in types.ts), not `type`. -->
					<div v-if="block.kind === 'text'" class="msg-body">{{ block.text }}</div>
					<details v-else-if="block.kind === 'thinking'" class="thinking">
						<summary>thinking</summary>
						<pre class="dim">{{ block.text }}</pre>
					</details>
					<ToolCard v-else-if="block.kind === 'tool'" :run="props.tools[block.toolCallId]" :fallback-name="block.toolName" />
				</template>
			</article>
		</div>
	</div>
</template>
