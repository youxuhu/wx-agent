<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionStore } from "../stores/session.ts";
import DiffView from "./DiffView.vue";

const store = useSessionStore();
onMounted(() => store.loadLog());
</script>

<template>
	<div class="pane">
		<div class="row">
			<button class="btn btn-sm" @click="store.loadLog()">Reload</button>
			<span class="chip">{{ store.gitLog.length }} commits</span>
			<button v-if="store.gitShow" class="btn btn-sm btn-ghost spacer" @click="store.gitShow = null">Close patch</button>
		</div>
		<p v-if="!store.gitLog.length" class="fact">No commits (or not a repository).</p>
		<div class="list">
			<div v-for="commit in store.gitLog" :key="commit.hash" class="list-row clickable" @click="store.showCommit(commit.hash)">
				<span class="mono tiny">{{ commit.short }}</span>
				<span class="ellipsis">{{ commit.subject }}</span>
				<span class="spacer" />
				<span v-if="commit.refs" class="chip">{{ commit.refs }}</span>
				<span class="tiny faint">{{ commit.date.slice(0, 16).replace("T", " ") }}</span>
			</div>
		</div>
		<div v-if="store.gitShow" class="col">
			<span class="tiny faint mono">{{ store.gitShow.ref }}</span>
			<DiffView :text="store.gitShow.text" />
		</div>
	</div>
</template>
