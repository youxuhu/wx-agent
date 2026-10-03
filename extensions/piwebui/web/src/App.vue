<script setup lang="ts">
/**
 * Codex-style shell: task sidebar, centred thread, composer, footer facts, and a collapsible
 * right drawer that carries everything else (files, changes, history, branches, preview, settings).
 * Facts only — every badge shows what the service reported.
 */
import { onMounted, ref } from "vue";
import MessageList from "./components/MessageList.vue";
import Composer from "./components/Composer.vue";
import ApprovalDialog from "./components/ApprovalDialog.vue";
import StatusBar from "./components/StatusBar.vue";
import FilePanel from "./components/FilePanel.vue";
import ChangesPanel from "./components/ChangesPanel.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import BranchPanel from "./components/BranchPanel.vue";
import PreviewPanel from "./components/PreviewPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import FolderPicker from "./components/FolderPicker.vue";
import { useSessionStore } from "./stores/session.ts";

const store = useSessionStore();
const sidebarOpen = ref(true);

const TABS = [
	{ key: "files", label: "Files" },
	{ key: "changes", label: "Changes" },
	{ key: "history", label: "History" },
	{ key: "branches", label: "Branches" },
	{ key: "preview", label: "Preview" },
	{ key: "settings", label: "Settings" },
] as const;

function toggleDrawer(key: string): void {
	if (key === "preview") {
		store.showPreview = store.drawer === "preview" ? false : true;
		store.drawer = store.drawer === "preview" ? "none" : "preview";
		return;
	}
	store.drawer = store.drawer === key ? "none" : (key as typeof store.drawer);
	if (store.drawer === "files") store.loadTree(store.cwd);
	if (store.drawer === "changes" || store.drawer === "branches") store.refreshGit();
}

onMounted(() => {
	store.connect();
	store.listenForPicks();
	store.loadWorkspacesOnce();
});
</script>

<template>
	<div class="app">
		<header class="topbar">
			<button class="btn btn-ghost btn-sm" :title="sidebarOpen ? 'Hide tasks' : 'Show tasks'" @click="sidebarOpen = !sidebarOpen">☰</button>
			<button class="btn btn-sm" @click="store.openFolderPicker()">{{ store.cwd || "choose folder" }}</button>
			<span class="chip" :class="store.conn === 'open' ? 'chip-ok' : 'chip-warn'">{{ store.conn }}</span>
			<span class="chip" :class="store.piState === 'running' ? 'chip-ok' : ''">pi: {{ store.piState }}</span>
			<span v-if="store.running" class="chip chip-warn">running</span>
			<span v-if="store.pendingUi.length" class="chip chip-danger">{{ store.pendingUi.length }} approval(s)</span>
			<span class="spacer" />
			<button
				v-for="tab in TABS"
				:key="tab.key"
				class="tab"
				:class="{ active: store.drawer === tab.key }"
				@click="toggleDrawer(tab.key)"
			>
				{{ tab.label }}
			</button>
		</header>

		<div class="body">
			<aside class="sidebar" :class="{ collapsed: !sidebarOpen }">
				<button class="btn btn-sm btn-primary" @click="store.newSession()">New session</button>
				<button class="btn btn-sm" @click="store.openFolderPicker()">Open folder…</button>
				<h4>Sessions</h4>
				<div class="side-list">
					<button
						v-for="session in store.sessions"
						:key="session.path"
						class="side-item"
						:class="{ active: session.path === store.currentSessionPath }"
						@click="store.switchSession(session.path)"
					>
						<span class="side-title">{{ session.name || session.firstPrompt || session.id }}</span>
						<span class="tiny faint">{{ new Date(session.updatedAt).toLocaleString() }} · {{ session.messageCount }} msg</span>
					</button>
					<p v-if="!store.sessions.length" class="tiny faint">No sessions for this directory yet.</p>
				</div>
				<div class="col">
					<span class="tiny faint ellipsis">workspace: {{ store.workspaces.length }}</span>
					<span class="tiny faint ellipsis">session: {{ store.sessionName || "(unnamed)" }}</span>
					<button class="btn btn-sm btn-ghost" @click="store.listSessions()">Refresh sessions</button>
				</div>
			</aside>

			<main class="main">
				<MessageList :messages="store.messages" :tools="store.tools" />
				<footer v-if="store.retry" class="banner row">
					<span class="chip chip-warn">retry {{ store.retry.attempt }}/{{ store.retry.max }}</span>
					<span class="ellipsis">{{ store.retry.reason }}</span>
				</footer>
				<footer v-if="store.notice" class="banner row">
					<span class="chip chip-warn">notice</span>
					<span>{{ store.notice }}</span>
				</footer>
				<footer v-if="store.lastError" class="banner row">
					<span class="chip chip-danger">error</span>
					<span>{{ store.lastError }}</span>
				</footer>
				<Composer
					:running="store.running"
					:queue-steering="store.queueSteering"
					:queue-follow-up="store.queueFollowUp"
					:draft="store.composerDraft"
					:draft-seq="store.composerSeq"
					@prompt="store.sendPrompt($event)"
					@steer="store.steer($event)"
					@abort="store.abort()"
				/>
				<div style="padding: 0 20px 8px">
					<StatusBar />
				</div>
			</main>

			<aside v-if="store.drawer !== 'none'" class="drawer">
				<div class="drawer-head">
					<strong class="small">{{ store.drawer }}</strong>
					<span class="spacer" />
					<button class="btn btn-ghost btn-sm" @click="store.drawer = 'none'">×</button>
				</div>
				<div class="drawer-body">
					<FilePanel v-if="store.drawer === 'files'" />
					<ChangesPanel v-else-if="store.drawer === 'changes'" />
					<HistoryPanel v-else-if="store.drawer === 'history'" />
					<BranchPanel v-else-if="store.drawer === 'branches'" />
					<PreviewPanel v-else-if="store.drawer === 'preview'" />
					<SettingsPanel v-else-if="store.drawer === 'settings'" />
				</div>
			</aside>
		</div>

		<ApprovalDialog
			:requests="store.pendingUi"
			@select="store.answerSelect($event.id, $event.value)"
			@confirm="store.answerConfirm($event.id, $event.confirmed)"
			@input="store.answerInput($event.id, $event.value)"
		/>
		<FolderPicker />
	</div>
</template>
