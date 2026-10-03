<script setup lang="ts">
/** Commit list plus the full `git show` of the selected commit. */
import { onMounted } from "vue";
import { Button, Space, Tag } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";
import DiffView from "./DiffView.vue";

const store = useSessionStore();
onMounted(() => store.loadLog());
</script>

<template>
	<div class="panel">
		<Space>
			<Button size="small" variant="outline" @click="store.loadLog()">reload</Button>
			<Tag size="small">{{ store.gitLog.length }} commits</Tag>
			<Button v-if="store.gitShow" size="small" variant="text" @click="store.gitShow = null">close patch</Button>
		</Space>
		<p v-if="!store.gitLog.length" class="dim">no commits (or not a repository)</p>
		<div class="log">
			<div v-for="commit in store.gitLog" :key="commit.hash" class="row commit" @click="store.showCommit(commit.hash)">
				<span class="sha">{{ commit.short }}</span>
				<span class="subject">{{ commit.subject }}</span>
				<Tag v-if="commit.refs" size="small" theme="notice">{{ commit.refs }}</Tag>
				<span class="dim when">{{ commit.date.slice(0, 16).replace("T", " ") }}</span>
			</div>
		</div>
		<div v-if="store.gitShow">
			<p class="dim">{{ store.gitShow.ref }}</p>
			<DiffView :text="store.gitShow.text" />
		</div>
	</div>
</template>

<style scoped>
.panel {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-height: 0;
	overflow: auto;
}

.log {
	border: 1px solid var(--px-neutral-5, #ddd);
	max-height: 40vh;
	overflow: auto;
}

.row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.commit {
	cursor: pointer;
	border-bottom: 1px solid var(--px-neutral-3, #eee);
}

.commit:hover {
	background: var(--px-neutral-2, #f4f4f4);
}

.sha {
	color: #6d28d9;
	font-family: var(--px-font, monospace);
}

.subject {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.when {
	font-size: 12px;
}

.dim {
	color: var(--px-neutral-8, #666);
	font-size: 12px;
}
</style>
