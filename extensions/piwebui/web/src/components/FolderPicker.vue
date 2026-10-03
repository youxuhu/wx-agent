<script setup lang="ts">
/** Open folder: browse allowed roots, recent workspaces, switch/close. */
import { ref } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const manual = ref("");
</script>

<template>
	<div v-if="store.showFolderPicker" class="overlay" @click.self="store.showFolderPicker = false">
		<div class="modal">
			<h3>Open folder</h3>
			<div class="row">
				<button v-for="root in store.browseRoots" :key="root.path" class="btn btn-sm" @click="store.browseTo(root.path)">{{ root.label }}</button>
				<button class="btn btn-sm" :disabled="!store.browseParent" @click="store.browseTo(store.browseParent ?? '')">Up</button>
				<button class="btn btn-sm btn-primary" @click="store.openFolder(store.browsePath)">Open this folder</button>
			</div>
			<p class="fact mono">{{ store.browsePath || "(not loaded)" }}</p>
			<p v-if="store.browseError" class="fact err">{{ store.browseError }}</p>

			<div class="list" style="max-height: 30vh">
				<div v-for="entry in store.browseEntries" :key="entry.path" class="list-row clickable" @click="store.browseTo(entry.path)">
					<span class="tree-caret">{{ entry.type === "dir" ? "▸" : "@" }}</span>
					<span>{{ entry.name }}</span>
				</div>
				<div v-if="!store.browseEntries.length" class="list-row faint">no subdirectories</div>
			</div>

			<div class="row-nowrap">
				<input v-model="manual" class="field" placeholder="paste an absolute path…" @keydown.enter="manual.trim() && store.openFolder(manual.trim())" />
				<button class="btn btn-sm" :disabled="!manual.trim()" @click="store.openFolder(manual.trim())">Open</button>
			</div>

			<h4>Open workspaces · {{ store.workspaces.length }}</h4>
			<div class="list">
				<div v-for="workspace in store.workspaces" :key="workspace.path" class="list-row">
					<span class="chip" :class="workspace.active ? 'chip-ok' : ''">{{ workspace.active ? "active" : workspace.state }}</span>
					<span v-if="workspace.pendingUi" class="chip chip-danger">{{ workspace.pendingUi }} dialog(s)</span>
					<span class="mono tiny ellipsis" @click="store.switchWorkspace(workspace.path)">{{ workspace.path }}</span>
					<span class="spacer" />
					<button v-if="!workspace.active" class="btn btn-sm btn-ghost" @click="store.switchWorkspace(workspace.path)">Switch</button>
					<button class="btn btn-sm btn-ghost btn-danger" @click="store.closeWorkspace(workspace.path)">Close</button>
				</div>
			</div>

			<h4 v-if="store.recentWorkspaces.length">Recent</h4>
			<div class="list">
				<div v-for="path in store.recentWorkspaces" :key="path" class="list-row clickable" @click="store.openFolder(path)">
					<span class="mono tiny ellipsis">{{ path }}</span>
				</div>
			</div>

			<p class="fact tiny">
				One writer at a time: only the active workspace accepts prompts and other write commands; the others stay open read-only and keep their
				pending approvals.
			</p>
			<div class="row">
				<button class="btn" @click="store.showFolderPicker = false">Close</button>
			</div>
		</div>
	</div>
</template>
