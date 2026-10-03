<script setup lang="ts">
/**
 * Session switcher: lists this working directory's sessions (facts read from disk by the
 * service) and switches the child to one of them via `switch_session`.
 */
import { computed, ref } from "vue";
import { Button, Drawer, Input, Space, Tag } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const draftName = ref("");

const rows = computed(() =>
	store.sessions.map((session) => ({
		...session,
		isCurrent: session.path === store.currentSessionPath,
		title: session.name || session.firstPrompt || session.id,
		when: formatWhen(session.updatedAt),
		size: `${Math.max(1, Math.round(session.sizeBytes / 1024))}KB`,
	})),
);

function formatWhen(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString();
}

function rename(): void {
	const name = draftName.value.trim();
	if (!name) return;
	store.renameSession(name);
	draftName.value = "";
}
</script>

<template>
	<Drawer :visible="store.showSessions" title="sessions" placement="right" :width="420" @update:visible="store.showSessions = $event">
		<div class="panel">
			<Space>
				<Button size="small" @click="store.newSession()">new session</Button>
				<Button size="small" variant="outline" @click="store.listSessions()">refresh</Button>
				<Button size="small" variant="outline" @click="store.compact()">compact</Button>
				<span class="dim">{{ rows.length }} in {{ store.cwd }}</span>
			</Space>

			<Space>
				<Input v-model="draftName" size="small" placeholder="rename current session…" />
				<Button size="small" variant="outline" :disabled="!draftName.trim()" @click="rename">rename</Button>
			</Space>
			<div class="dim current">
				current: {{ store.sessionName || "(unnamed)" }}<br />
				{{ store.currentSessionPath || "(no session file yet)" }}
			</div>

			<div class="list">
				<button
					v-for="row in rows"
					:key="row.path"
					class="row"
					:class="{ current: row.isCurrent }"
					:title="row.path"
					@click="store.switchSession(row.path)"
				>
					<div class="row-head">
						<Tag :theme="row.isCurrent ? 'success' : 'notice'" size="small">{{ row.isCurrent ? "current" : "switch" }}</Tag>
						<span class="dim">{{ row.when }}</span>
						<span class="dim">{{ row.messageCount }} msg · {{ row.size }}</span>
					</div>
					<div class="row-title">{{ row.title }}</div>
				</button>
				<div v-if="!rows.length" class="dim">no sessions for this directory yet</div>
			</div>
		</div>
	</Drawer>
</template>

<style scoped>
.panel {
	display: flex;
	flex-direction: column;
	gap: 10px;
	height: 100%;
}

.list {
	display: flex;
	flex-direction: column;
	gap: 6px;
	overflow: auto;
	flex: 1;
}

.row {
	text-align: left;
	background: transparent;
	border: 2px solid var(--px-neutral-5);
	padding: 6px 8px;
	cursor: pointer;
	font-family: var(--px-font);
	color: inherit;
}

.row:hover {
	border-color: var(--px-primary-6);
}

.row.current {
	border-color: var(--px-success-6);
}

.row-head {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.row-title {
	margin-top: 4px;
	word-break: break-word;
}

.current {
	word-break: break-all;
}
</style>
