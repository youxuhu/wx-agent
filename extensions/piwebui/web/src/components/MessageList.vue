<script setup lang="ts">
/**
 * Codex-style thread: user blocks, assistant text, collapsible thinking and tool rows.
 *
 * Scrolling follows the TUI: output keeps the view pinned to the newest line only while the
 * reader is already at the bottom. Scrolling up stops the following; `End` (or the ↓ control
 * that appears) returns to the newest line.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ChatMessage, ToolRun } from "../types.ts";
import { isAtBottom } from "../scroll.ts";
import ToolCard from "./ToolCard.vue";

const props = defineProps<{ messages: ChatMessage[]; tools: Record<string, ToolRun> }>();

const threadEl = ref<HTMLElement | null>(null);
/** True while the reader sits at the bottom (then new output follows). */
const stick = ref(true);
let observer: ResizeObserver | null = null;

function onScroll(): void {
	const el = threadEl.value;
	if (el) stick.value = isAtBottom(el);
}

function jumpToLatest(): void {
	const el = threadEl.value;
	if (!el) return;
	el.scrollTop = el.scrollHeight;
	stick.value = true;
}

/**
 * Content can grow without any prop changing (streaming text, tool output, an expanded card),
 * so the box itself is observed instead of the data.
 */
function follow(): void {
	if (!stick.value) return;
	void nextTick(() => {
		const el = threadEl.value;
		if (el && stick.value) el.scrollTop = el.scrollHeight;
	});
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key !== "End" || event.metaKey || event.ctrlKey || event.altKey) return;
	const target = event.target as HTMLElement | null;
	if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
	event.preventDefault();
	jumpToLatest();
}

onMounted(() => {
	const el = threadEl.value;
	observer = new ResizeObserver(follow);
	if (el) observer.observe(el.firstElementChild ?? el);
	// Opening a conversation shows its newest message, not its oldest.
	jumpToLatest();
	window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
	observer?.disconnect();
	observer = null;
	window.removeEventListener("keydown", onKeydown);
});

/** A replaced array means another conversation: start pinned at the newest message again. */
watch(
	() => props.messages,
	() => {
		stick.value = true;
		void nextTick(jumpToLatest);
	},
);
</script>

<template>
	<div class="thread-wrap">
		<div ref="threadEl" class="thread" @scroll="onScroll">
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
		<button
			v-if="!stick"
			class="jump-latest"
			type="button"
			title="Jump to latest (End)"
			aria-label="Jump to latest"
			@click="jumpToLatest"
		>
			↓
		</button>
	</div>
</template>
