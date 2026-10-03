<script setup lang="ts">
/**
 * Approval dialog — renders pi extension UI requests (select / confirm / input).
 *
 * Invariant: nothing here defaults to "allow". Closing the dialog (Esc / mask) sends a
 * cancellation, which pi reports to the extension as undefined/false — i.e. not approved.
 */
import { computed, ref, watch } from "vue";
import { Button, Dialog, Space, Tag, Textarea } from "@pixelium/web-vue";
import type { UiRequest } from "../types.ts";

const props = defineProps<{ requests: UiRequest[] }>();
const emit = defineEmits<{ (event: "select", payload: { id: string; value?: string }): void; (event: "confirm", payload: { id: string; confirmed: boolean }): void }>();

const request = computed(() => props.requests[0]);
const draft = ref("");

watch(
	() => request.value?.id,
	() => {
		draft.value = "";
	},
);

const deadline = computed(() => {
	const timeout = request.value?.timeout;
	if (typeof timeout !== "number") return "";
	return `expires in ${(timeout / 1000).toFixed(0)}s at most (then it is reported as cancelled, never allowed)`;
});

function close(): void {
	const current = request.value;
	if (!current) return;
	if (current.method === "confirm") emit("confirm", { id: current.id, confirmed: false });
	else emit("select", { id: current.id, value: undefined });
}
</script>

<template>
	<Dialog
		v-if="request"
		:visible="true"
		:title="request.title || 'approval required'"
		:mask-closable="false"
		:show-footer="false"
		class="ui-dialog"
	>
		<div class="ui-body">
			<Space>
				<Tag theme="warning">pi asks</Tag>
				<Tag theme="notice">{{ request.method }}</Tag>
				<span v-if="deadline" class="dim">{{ deadline }}</span>
			</Space>

			<p v-if="request.message" class="ui-message">{{ request.message }}</p>

			<template v-if="request.method === 'select'">
				<Space direction="vertical" class="ui-options">
					<Button v-for="option in request.options || []" :key="option" variant="outline" block @click="emit('select', { id: request.id, value: option })">
						{{ option }}
					</Button>
				</Space>
			</template>

			<template v-else-if="request.method === 'confirm'">
				<Space>
					<Button @click="emit('confirm', { id: request.id, confirmed: true })">yes</Button>
					<Button variant="outline" theme="danger" @click="emit('confirm', { id: request.id, confirmed: false })">no</Button>
				</Space>
			</template>

			<template v-else>
				<Textarea v-model="draft" :rows="3" :placeholder="request.placeholder || ''" />
				<Space>
					<Button @click="emit('select', { id: request.id, value: draft })">submit</Button>
				</Space>
			</template>

			<Space>
				<Button variant="text" theme="danger" @click="close">dismiss (counts as not approved)</Button>
			</Space>
		</div>
	</Dialog>
</template>

<style scoped>
.ui-body {
	display: flex;
	flex-direction: column;
	gap: 10px;
	max-width: 640px;
}

.ui-message {
	white-space: pre-wrap;
	word-break: break-word;
	margin: 0;
	max-height: 40vh;
	overflow: auto;
}

.ui-options {
	width: 100%;
}
</style>
