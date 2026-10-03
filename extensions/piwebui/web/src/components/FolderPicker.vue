<script setup lang="ts">
/**
 * "Open folder": browses directories the service allows (home and /tmp), lists recently used
 * workspaces and lets the user close one. Opening a folder always goes through the service.
 */
import { Button, Dialog, Input, Space, Tag } from "@pixelium/web-vue";
import { ref } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const manual = ref("");
</script>

<template>
	<Dialog
		:visible="store.showFolderPicker"
		title="open folder"
		:mask-closable="true"
		@update:visible="(visible: boolean) => { if (!visible) store.showFolderPicker = false; }"
	>
		<div class="picker">
			<Space>
				<Button v-for="root in store.browseRoots" :key="root.path" size="small" variant="outline" @click="store.browseTo(root.path)">
					{{ root.label }}
				</Button>
				<Button size="small" variant="outline" :disabled="!store.browseParent" @click="store.browseTo(store.browseParent ?? '')">.. up</Button>
				<Button size="small" @click="store.openFolder(store.browsePath)">open this folder</Button>
			</Space>

			<p class="dim mono">{{ store.browsePath || "(not loaded)" }}</p>
			<p v-if="store.browseError" class="fact err">{{ store.browseError }}</p>

			<div class="dirs">
				<div v-for="entry in store.browseEntries" :key="entry.path" class="row dir" @click="store.browseTo(entry.path)">
					<span class="caret">{{ entry.type === "dir" ? "▸" : "@" }}</span>
					<span>{{ entry.name }}</span>
				</div>
				<p v-if="!store.browseEntries.length" class="dim">no subdirectories</p>
			</div>

			<Space>
				<Input v-model="manual" size="small" placeholder="paste an absolute path…" @keydown.enter="manual.trim() && store.openFolder(manual.trim())" />
				<Button size="small" variant="outline" :disabled="!manual.trim()" @click="store.openFolder(manual.trim())">open</Button>
			</Space>

			<h4>open workspaces ({{ store.workspaces.length }})</h4>
			<div v-for="workspace in store.workspaces" :key="workspace.path" class="row ws">
				<Tag size="small" :theme="workspace.active ? 'success' : 'notice'">{{ workspace.active ? "active" : workspace.state }}</Tag>
				<Tag v-if="workspace.pendingUi" size="small" theme="danger">{{ workspace.pendingUi }} dialog(s)</Tag>
				<span class="path" @click="store.switchWorkspace(workspace.path)">{{ workspace.path }}</span>
				<Button v-if="!workspace.active" size="small" variant="text" @click="store.switchWorkspace(workspace.path)">switch</Button>
				<Button size="small" variant="text" theme="danger" @click="store.closeWorkspace(workspace.path)">close</Button>
			</div>

			<h4 v-if="store.recentWorkspaces.length">recent</h4>
			<div v-for="path in store.recentWorkspaces" :key="path" class="row recent" @click="store.openFolder(path)">
				<span class="path">{{ path }}</span>
			</div>

			<p class="fact">
				同一时刻只有一个 workspace 能写（单写者）：其它 workspace 的子进程保留、只读观察；切换时它们的未决审批仍留在原 workspace。
			</p>
		</div>
	</Dialog>
</template>

<style scoped>
.picker {
	display: flex;
	flex-direction: column;
	gap: 8px;
	max-height: 70vh;
	overflow: auto;
}

.row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.dirs {
	border: 1px solid var(--px-neutral-5, #ddd);
	max-height: 30vh;
	overflow: auto;
}

.dir,
.recent {
	cursor: pointer;
}

.dir:hover,
.recent:hover {
	background: var(--px-neutral-2, #f4f4f4);
}

.caret {
	width: 12px;
	color: var(--px-neutral-7, #888);
}

.path {
	font-family: var(--px-font, monospace);
	cursor: pointer;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 60%;
}

h4 {
	margin: 4px 0 0;
	font-size: 13px;
}

.mono {
	font-family: var(--px-font, monospace);
}

.dim {
	color: var(--px-neutral-8, #666);
	font-size: 12px;
	margin: 0;
}

.fact {
	margin: 0;
	font-size: 12px;
}

.err {
	color: #b91c1c;
}
</style>
