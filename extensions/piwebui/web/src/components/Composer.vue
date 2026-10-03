<script setup lang="ts">
/** Composer: send a prompt, steer a running run, or abort it. */
import { ref } from "vue";
import { Button, Space, Switch, Textarea } from "@pixelium/web-vue";

const props = defineProps<{ running: boolean; queue: number }>();
const emit = defineEmits<{ (event: "prompt", text: string): void; (event: "steer", text: string): void; (event: "abort"): void }>();

const text = ref("");
const steerMode = ref(false);

function submit(): void {
	const value = text.value.trim();
	if (!value) return;
	emit(steerMode.value ? "steer" : "prompt", value);
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
				<Button :disabled="!text.trim()" @click="submit">{{ steerMode ? "steer" : "send" }}</Button>
				<Button v-if="props.running" variant="outline" theme="danger" @click="emit('abort')">abort</Button>
				<Switch v-model="steerMode" size="small" />
				<span class="dim">steer mode{{ props.queue ? ` · queued: ${props.queue}` : "" }}</span>
			</Space>
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
</style>
