<script setup lang="ts">
/**
 * Layout: status header, session stream, composer, approval overlay.
 * Facts only — every badge shows what the service reported.
 */
import { onMounted } from "vue";
import { Badge, Button, Space, Tag } from "@pixelium/web-vue";
import MessageList from "./components/MessageList.vue";
import Composer from "./components/Composer.vue";
import ApprovalDialog from "./components/ApprovalDialog.vue";
import { useSessionStore } from "./stores/session.ts";

const store = useSessionStore();

onMounted(() => store.connect());
</script>

<template>
	<div class="app">
		<header class="head">
			<Tag theme="primary">pi-web-ui</Tag>
			<Tag :theme="store.conn === 'open' ? 'success' : store.conn === 'connecting' ? 'warning' : 'danger'">{{ store.conn }}</Tag>
			<Tag :theme="store.piState === 'running' ? 'success' : 'notice'">pi:{{ store.piState }}</Tag>
			<Tag v-if="store.running" theme="warning">running</Tag>
			<span class="dim ellipsis">{{ store.cwd }}</span>
			<Space class="head-right">
				<Badge v-if="store.pendingUi.length" theme="danger">{{ store.pendingUi.length }} approval{{ store.pendingUi.length > 1 ? "s" : "" }}</Badge>
				<Button size="small" variant="text" @click="store.newSession()">new session</Button>
				<Button size="small" variant="text" @click="store.compact()">compact</Button>
			</Space>
		</header>

		<main class="main">
			<MessageList :messages="store.messages" :tools="store.tools" />
		</main>

		<footer v-if="store.retry" class="err">
			<Tag theme="warning">retry {{ store.retry.attempt }}/{{ store.retry.max }}</Tag>
			<span class="ellipsis">{{ store.retry.reason }}</span>
		</footer>

		<footer v-if="store.lastError" class="err">
			<Tag theme="danger">error</Tag>
			<span>{{ store.lastError }}</span>
		</footer>

		<Composer
			:running="store.running"
			:queue-steering="store.queueSteering"
			:queue-follow-up="store.queueFollowUp"
			@prompt="store.sendPrompt($event)"
			@steer="store.steer($event)"
			@abort="store.abort()"
		/>

		<ApprovalDialog
			:requests="store.pendingUi"
			@select="store.answerSelect($event.id, $event.value)"
			@confirm="store.answerConfirm($event.id, $event.confirmed)"
		/>
	</div>
</template>

<style scoped>
.app {
	display: flex;
	flex-direction: column;
	gap: 8px;
	height: 100%;
	padding: 10px 12px;
	box-sizing: border-box;
}

.head {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	border-bottom: 2px solid var(--px-neutral-6);
	padding-bottom: 6px;
}

.head-right {
	margin-left: auto;
}

.main {
	flex: 1;
	overflow: auto;
	min-height: 0;
}

.err {
	display: flex;
	gap: 6px;
	align-items: center;
}

.ellipsis {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 45vw;
}
</style>
