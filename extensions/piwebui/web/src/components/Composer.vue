<script setup lang="ts">
/**
 * Composer: prompt, steer or abort. Steer is only meaningful during a run, so the control is
 * disabled while idle instead of queueing a message nobody consumes.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
	running: boolean;
	queueSteering: number;
	queueFollowUp: number;
	draft: string;
	draftSeq: number;
	busyHint?: string;
}>();
const emit = defineEmits<{
	(event: "prompt", text: string): void;
	(event: "steer", text: string): void;
	(event: "abort"): void;
	(event: "notice", text: string): void;
}>();

const text = ref("");
const steerMode = ref(false);
/**
 * The key hint is part of the placeholder, so in a narrow window it wraps the placeholder onto
 * three lines and the input box grows for no reason. The hint stays reachable as a tooltip.
 */
const narrow = window.matchMedia("(max-width: 640px)");
const isNarrow = ref(narrow.matches);
const onNarrowChange = (event: MediaQueryListEvent): void => {
	isNarrow.value = event.matches;
};
const area = ref<HTMLTextAreaElement | null>(null);
/**
 * The steer switch is always clickable. It only *changes delivery* while a run is active:
 * steering is defined as "delivered after the current turn's tool calls", so with no active run
 * there is nothing to steer — the message goes out as a normal prompt and we say so instead of
 * silently pretending.
 */
const effectiveSteer = computed(() => steerMode.value && props.running);

function submit(): void {
	const value = text.value.trim();
	if (!value) return;
	if (effectiveSteer.value) {
		emit("steer", value);
		emit("notice", "");
	} else {
		if (steerMode.value) emit("notice", "no active run — steer only applies mid-run, so this was sent as a normal prompt");
		emit("prompt", value);
	}
	text.value = "";
	grow();
}

function grow(): void {
	const element = area.value;
	if (!element) return;
	element.style.height = "auto";
	element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		submit();
	}
}

watch(
	() => props.draftSeq,
	async () => {
		if (!props.draft) return;
		text.value = text.value.trim() ? `${text.value.trim()}\n\n${props.draft}` : props.draft;
		await nextTick();
		grow();
		area.value?.focus();
	},
);

onMounted(() => {
	narrow.addEventListener("change", onNarrowChange);
	grow();
});

onBeforeUnmount(() => {
	narrow.removeEventListener("change", onNarrowChange);
});
</script>

<template>
	<div class="composer">
		<div class="composer-inner">
			<div class="composer-box">
				<textarea
					ref="area"
					v-model="text"
					rows="1"
					:placeholder="isNarrow ? 'Ask pi to do something…' : 'Ask pi to do something…  (Enter to send, Shift+Enter for newline)'"
					:title="'Enter to send, Shift+Enter for newline'"
					@input="grow"
					@keydown="onKeydown"
				/>
				<button v-if="props.running" class="btn btn-sm btn-danger" @click="emit('abort')">Stop</button>
				<button v-else class="btn btn-sm btn-primary" :disabled="!text.trim()" @click="submit()">Send</button>
			</div>
			<div class="statusline">
				<label class="row tiny" :title="props.running
					? 'delivered after the current turn\'s tool calls, before the next LLM call'
					: 'no active run: sending now goes out as a normal prompt'">
					<input v-model="steerMode" type="checkbox" />
					<span>steer current run</span>
				</label>
				<span v-if="steerMode && !props.running" class="tiny faint">no active run — will be sent as a normal prompt</span>
				<span v-if="props.queueSteering" class="tiny">queued steering: {{ props.queueSteering }}</span>
				<span v-if="props.queueFollowUp" class="tiny">queued follow-up: {{ props.queueFollowUp }}</span>
				<span v-if="props.busyHint" class="tiny">{{ props.busyHint }}</span>
			</div>
		</div>
	</div>
</template>
