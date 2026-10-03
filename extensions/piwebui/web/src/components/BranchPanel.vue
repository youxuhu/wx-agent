<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const draft = ref("");
const local = computed(() => store.gitBranches.filter((branch) => !branch.remote));
const remote = computed(() => store.gitBranches.filter((branch) => branch.remote));

function create(): void {
	const name = draft.value.trim();
	if (!name) return;
	store.createGitBranch(name);
	draft.value = "";
}

onMounted(() => store.refreshGit());
</script>

<template>
	<div class="pane">
		<div class="row">
			<button class="btn btn-sm" @click="store.refreshGit()">Refresh</button>
			<span class="chip">⎇ {{ store.gitStatus?.branch ?? "?" }}</span>
		</div>
		<div class="row-nowrap">
			<input v-model="draft" class="field" placeholder="new branch name…" @keydown.enter="create()" />
			<button class="btn btn-sm" :disabled="!draft.trim()" @click="create()">Create</button>
		</div>

		<h4>Local · {{ local.length }}</h4>
		<div class="list">
			<div v-for="branch in local" :key="branch.name" class="list-row">
				<span class="chip" :class="branch.name === store.gitStatus?.branch ? 'chip-ok' : ''">{{ branch.name === store.gitStatus?.branch ? "current" : "local" }}</span>
				<span class="mono ellipsis">{{ branch.name }}</span>
				<span class="tiny faint">{{ branch.sha }}</span>
				<span class="spacer" />
				<button v-if="branch.name !== store.gitStatus?.branch" class="btn btn-sm btn-ghost" @click="store.checkoutBranch(branch.name)">Checkout</button>
			</div>
		</div>

		<h4>Remote · {{ remote.length }}</h4>
		<div class="list">
			<div v-for="branch in remote" :key="branch.name" class="list-row">
				<span class="mono ellipsis">{{ branch.name }}</span>
				<span class="tiny faint">{{ branch.sha }}</span>
			</div>
		</div>

		<p v-if="store.gitNotice" class="fact">{{ store.gitNotice }}</p>
	</div>
</template>
