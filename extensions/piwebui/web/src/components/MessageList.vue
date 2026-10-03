<script setup lang="ts">
/** Message list: text / thinking / tool blocks, streamed in place. */
import { Collapse, CollapseItem, Tag } from "@pixelium/web-vue";
import ToolCard from "./ToolCard.vue";
import type { ChatMessage, ToolRun } from "../types.ts";

const props = defineProps<{ messages: ChatMessage[]; tools: Record<string, ToolRun> }>();

function toolFor(toolCallId: string): ToolRun | undefined {
	return props.tools[toolCallId];
}
</script>

<template>
	<div class="messages">
		<div v-if="!props.messages.length" class="empty dim">no messages yet — send a prompt below</div>
		<article v-for="message in props.messages" :key="message.id" class="msg" :class="`msg-${message.role}`">
			<div class="msg-head">
				<Tag :theme="message.role === 'user' ? 'primary' : message.role === 'assistant' ? 'success' : 'info'">{{ message.role }}</Tag>
				<Tag v-if="!message.done" theme="warning">streaming</Tag>
			</div>

			<template v-for="(block, index) in message.blocks" :key="`${message.id}-${index}`">
				<pre v-if="block.kind === 'text'" class="text">{{ block.text }}</pre>
				<Collapse v-else-if="block.kind === 'thinking'" class="thinking">
					<CollapseItem title="thinking">
						<pre class="text dim">{{ block.text }}</pre>
					</CollapseItem>
				</Collapse>
				<ToolCard v-else-if="block.kind === 'tool' && toolFor(block.toolCallId)" :run="toolFor(block.toolCallId)!" />
			</template>
		</article>
	</div>
</template>

<style scoped>
.messages {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 4px 2px 16px;
}

.msg {
	border-left: 4px solid var(--px-neutral-6);
	padding-left: 10px;
}

.msg-user {
	border-left-color: var(--px-primary-6);
}

.msg-assistant {
	border-left-color: var(--px-success-6);
}

.msg-head {
	display: flex;
	gap: 6px;
	align-items: center;
	margin-bottom: 4px;
}

.text {
	white-space: pre-wrap;
	word-break: break-word;
	margin: 0;
	font-family: var(--px-font);
	font-size: var(--px-medium-font-size);
}

.empty {
	padding: 20px 0;
}
</style>
