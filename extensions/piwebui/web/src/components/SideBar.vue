<script setup lang="ts">
/** Left sidebar: file tree, source control, history, branches. */
import { Button, Tag } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";
import FilePanel from "./FilePanel.vue";
import ChangesPanel from "./ChangesPanel.vue";
import HistoryPanel from "./HistoryPanel.vue";
import BranchPanel from "./BranchPanel.vue";

const store = useSessionStore();
const TABS = ["files", "changes", "history", "branches"] as const;
</script>

<template>
	<aside class="side">
		<div class="tabs">
			<Button
				v-for="tab in TABS"
				:key="tab"
				size="small"
				:variant="store.sidebar === tab ? 'primary' : 'outline'"
				@click="store.openSidebar(tab)"
			>
				{{ tab }}
			</Button>
			<Tag size="small">⎇ {{ store.gitStatus?.branch ?? "?" }}</Tag>
			<Button size="small" variant="text" class="close" @click="store.sidebar = 'none'">×</Button>
		</div>
		<div class="body">
			<FilePanel v-if="store.sidebar === 'files'" />
			<ChangesPanel v-else-if="store.sidebar === 'changes'" />
			<HistoryPanel v-else-if="store.sidebar === 'history'" />
			<BranchPanel v-else-if="store.sidebar === 'branches'" />
		</div>
	</aside>
</template>

<style scoped>
.side {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
	min-height: 0;
	overflow: hidden;
	border-right: 1px solid var(--px-neutral-5, #ddd);
	padding-right: 8px;
}

.tabs {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.close {
	margin-left: auto;
}

.body {
	flex: 1;
	min-height: 0;
	overflow: auto;
}
</style>
