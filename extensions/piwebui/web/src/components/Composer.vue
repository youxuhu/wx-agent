<script setup lang="ts">
/**
 * Composer: send a prompt, steer a running run, or abort it.
 *
 * steer = delivered after the current assistant turn finishes its tool calls and
 * before the next LLM call (mid-run redirection). It only means something while a
 * run is active, so the toggle is disabled when idle rather than queueing a message
 * that nobody is waiting for.
 */
import { computed, ref } from "vue";
import { Button, Space, Switch, Textarea, Tooltip } from "@pixelium/web-vue";

const props = defineProps<{ running: boolean; queueSteering: number; queueFollowUp: number }>();
const emit = defineEmits<{ (event: "prompt", text: string): void; (event: "steer", text: string): void; (event: "abort"): void }>();

const text = ref("");
const steerMode = ref(false);
const effectiveSteer = computed(() => steerMode.value && props.running);

function submit(): void {
	const value = text.value.trim();
	if (!value) return;
	emit(effectiveSteer.value ? "steer" : "prompt", value);
	text.value = "";
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		submit();
	}
}
</script>

<template>
	<div class="composer">
		<Textarea v-model="text" :rows="3" placeholder="prompt…  (⌘/Ctrl+Enter to send)" @keydown="onKeydown" />
		<div class="composer-row">
			<Space>
				<Button :disabled="!text.trim()" @click="submit">{{ effectiveSteer ? "steer" : "send" }}</Button>
				<Button v-if="props.running" variant="outline" theme="danger" @click="emit('abort')">abort</Button>
				<Tooltip content="steer: delivered after the current turn's tool calls, before the next LLM call (only while a run is active)">
					<span class="steer-toggle">
						<Switch v-model="steerMode" :disabled="!props.running" size="small" />
						<span class="dim">steer</span>
					</span>
				</Tooltip>
			</Space>
			<span class="dim queue">
				<span v-if="props.queueSteering">steering: {{ props.queueSteering }}</span>
				<span v-if="props.queueFollowUp">follow-up: {{ props.queueFollowUp }}</span>
				<span v-if="!props.running && !props.queueSteering && !props.queueFollowUp">idle</span>
			</span>
		</div>
	</div>
</template>

<style scoped>
.composer {
	display: flex;
	flex-direction: column;
	gap: 6px;
	border-top: 2px solid var(--px-neutral-6);
	padding-top: 8px;
}

.composer-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.steer-toggle {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.queue {
	display: inline-flex;
	gap: 10px;
}
</style>
