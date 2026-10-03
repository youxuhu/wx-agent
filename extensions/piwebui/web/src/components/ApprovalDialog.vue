<script setup lang="ts">
/**
 * Approval dialogs from pi's extension UI protocol. Answering is always explicit: closing the
 * dialog counts as "not approved", and nothing is auto-allowed (PLAN.md §5).
 */
import { computed, ref } from "vue";
import type { UiRequest } from "../types.ts";

const props = defineProps<{ requests: UiRequest[] }>();
const emit = defineEmits<{
	(event: "select", payload: { id: string; value?: string }): void;
	(event: "confirm", payload: { id: string; confirmed: boolean }): void;
	(event: "input", payload: { id: string; value?: string }): void;
}>();

const inputDraft = ref("");
const current = computed(() => props.requests[0]);
const options = computed(() => (current.value?.options ?? []) as Array<string | { label?: string; value?: string; description?: string }>);
const target = computed(() => {
	const request = current.value;
	if (!request) return "";
	const args = (request as { payload?: Record<string, unknown> }).payload ?? {};
	return String(args.command ?? args.path ?? args.tool ?? "");
});
const rule = computed(() => String((current.value as { rule?: string })?.rule ?? ""));

function choose(option: string | { label?: string; value?: string }): void {
	const request = current.value;
	if (!request) return;
	const value = typeof option === "string" ? option : (option.value ?? option.label ?? "");
	emit("select", { id: request.id, value });
}

function label(option: string | { label?: string; value?: string }): string {
	return typeof option === "string" ? option : (option.label ?? option.value ?? "");
}

function dismiss(): void {
	const request = current.value;
	if (!request) return;
	emit("select", { id: request.id, value: undefined });
}
</script>

<template>
	<div v-if="current" class="overlay">
		<div class="modal">
			<h3>{{ current.title || (current.method === "confirm" ? "Confirm" : "Approval required") }}</h3>
			<p v-if="target" class="fact mono">target: {{ target }}</p>
			<p v-if="rule" class="fact">rule: {{ rule }}</p>
			<p v-if="current.message" class="fact">{{ current.message }}</p>
			<p class="tiny faint">
				timeout: {{ current.timeout ? `${current.timeout} ms` : "none — waits until answered" }}
				<template v-if="props.requests.length > 1"> · {{ props.requests.length - 1 }} more waiting</template>
			</p>

			<div v-if="current.method === 'confirm'" class="row">
				<button class="btn btn-primary" @click="emit('confirm', { id: current.id, confirmed: true })">Confirm</button>
				<button class="btn" @click="emit('confirm', { id: current.id, confirmed: false })">Cancel</button>
			</div>

			<div v-else-if="current.method === 'input' || current.method === 'editor'" class="col">
				<textarea v-model="inputDraft" class="textarea" :rows="current.method === 'editor' ? 8 : 3" :placeholder="current.placeholder ?? ''" />
				<div class="row">
					<button class="btn btn-primary" @click="emit('input', { id: current.id, value: inputDraft })">Submit</button>
					<button class="btn" @click="emit('input', { id: current.id, value: undefined })">Cancel</button>
				</div>
			</div>

			<div v-else class="col">
				<button v-for="option in options" :key="label(option)" class="btn" style="justify-content: flex-start" @click="choose(option)">
					{{ label(option) }}
				</button>
				<input v-if="!options.length" v-model="inputDraft" class="field" placeholder="value…" @keydown.enter="emit('select', { id: current.id, value: inputDraft })" />
			</div>

			<div class="row">
				<button class="btn btn-ghost" @click="dismiss()">Dismiss (counts as not approved)</button>
			</div>
		</div>
	</div>
</template>
