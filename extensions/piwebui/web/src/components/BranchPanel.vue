<script setup lang="ts">
/** Branch list and switching. A dirty tree is refused by the service, not worked around here. */
import { computed, onMounted, ref } from "vue";
import { Button, Input, Space, Tag } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const draft = ref("");

const local = computed(() => store.gitBranches.filter((branch) => !branch.remote));
const remote = computed(() => store.gitBranches.filter((branch) => branch.remote));

onMounted(() => store.refreshGit());
</script>

<template>
	<div class="panel">
		<Space>
			<Button size="small" variant="outline" @click="store.refreshGit()">refresh</Button>
			<Tag size="small">⎇ {{ store.gitStatus?.branch ?? "?" }}</Tag>
		</Space>
		<div class="row">
			<Input v-model="draft" size="small" placeholder="new branch name…" @keydown.enter="draft.trim() && (store.createGitBranch(draft.trim()), (draft = ''))" />
			<Button size="small" variant="outline" :disabled="!draft.trim()" @click="store.createGitBranch(draft.trim()); draft = ''">create + checkout</Button>
		</div>

		<h4>local ({{ local.length }})</h4>
		<div v-for="branch in local" :key="branch.name" class="row branch">
			<Tag size="small" :theme="branch.name === store.gitStatus?.branch ? 'success' : 'notice'">
				{{ branch.name === store.gitStatus?.branch ? "current" : "switch" }}
			</Tag>
			<span class="name">{{ branch.name }}</span>
			<span class="dim">{{ branch.sha }}</span>
			<span v-if="branch.upstream" class="dim">→ {{ branch.upstream }}</span>
			<Button v-if="branch.name !== store.gitStatus?.branch" size="small" variant="text" @click="store.checkoutBranch(branch.name)">checkout</Button>
		</div>

		<h4>remote ({{ remote.length }})</h4>
		<div v-for="branch in remote" :key="branch.name" class="row branch">
			<span class="name">{{ branch.name }}</span>
			<span class="dim">{{ branch.sha }}</span>
		</div>

		<p v-if="store.gitNotice" class="fact">{{ store.gitNotice }}</p>
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

.row {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.branch {
	border-bottom: 1px solid var(--px-neutral-3, #eee);
}

h4 {
	margin: 6px 0 2px;
	font-size: 13px;
}

.name {
	font-family: var(--px-font, monospace);
}

.dim {
	color: var(--px-neutral-8, #666);
	font-size: 12px;
}

.fact {
	margin: 0;
	font-size: 12px;
}
</style>
