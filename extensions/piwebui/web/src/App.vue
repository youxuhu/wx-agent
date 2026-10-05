<script setup lang="ts">
/**
 * Codex-style shell: task sidebar, centred thread, composer, footer facts, and a collapsible
 * right drawer that carries everything else (files, changes, history, branches, preview, settings).
 * Facts only — every badge shows what the service reported.
 */
import { computed, onMounted, ref } from "vue";
import { compactPath } from "./path.ts";
import MessageList from "./components/MessageList.vue";
import Composer from "./components/Composer.vue";
import ApprovalDialog from "./components/ApprovalDialog.vue";
import StatusBar from "./components/StatusBar.vue";
import FilePanel from "./components/FilePanel.vue";
import ShellPanel from "./components/ShellPanel.vue";
import ChangesPanel from "./components/ChangesPanel.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import BranchPanel from "./components/BranchPanel.vue";
import PreviewPanel from "./components/PreviewPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import FolderPicker from "./components/FolderPicker.vue";
import { healthOf } from "./health.ts";
import { useSessionStore } from "./stores/session.ts";

const store = useSessionStore();
const sidebarOpen = ref(true);

/**
 * Short label for the workspace entry: the folder's own name, with the full path kept in the
 * tooltip (and in the sidebar footer when the sidebar is visible).
 */
const cwdLabel = computed(() => (store.cwd ? compactPath(store.cwd) : "Open folder…"));

/**
 * Right drawer width: dragged by the handle on its left edge and remembered per browser.
 * Clamped so the thread keeps a usable width.
 */
const DRAWER_KEY = "piwebui.drawerWidth";
const drawerWidth = ref(Number(localStorage.getItem(DRAWER_KEY) ?? 0) || 460);

function applyDrawerWidth(): void {
	document.documentElement.style.setProperty("--drawer-w", `${drawerWidth.value}px`);
}

function startResize(event: PointerEvent): void {
	event.preventDefault();
	const move = (moveEvent: PointerEvent): void => {
		const next = window.innerWidth - moveEvent.clientX;
		drawerWidth.value = Math.max(320, Math.min(next, Math.max(360, window.innerWidth - 380)));
		applyDrawerWidth();
	};
	const stop = (): void => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", stop);
		localStorage.setItem(DRAWER_KEY, String(Math.round(drawerWidth.value)));
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", stop);
}

function resetDrawerWidth(): void {
	setDrawerWidth(460);
}

function setDrawerWidth(value: number): void {
	drawerWidth.value = Math.max(320, Math.min(value, Math.max(360, window.innerWidth - 380)));
	applyDrawerWidth();
	localStorage.setItem(DRAWER_KEY, String(Math.round(drawerWidth.value)));
}

/** The handle is a real separator: draggable, and adjustable with the arrow keys. */
function onResizeKey(event: KeyboardEvent): void {
	if (event.key === "ArrowLeft") setDrawerWidth(drawerWidth.value + 24);
	else if (event.key === "ArrowRight") setDrawerWidth(drawerWidth.value - 24);
	else if (event.key === "Home") resetDrawerWidth();
	else return;
	event.preventDefault();
}

/** Service socket + pi child rolled into one line (see web/src/health.ts). */const health = computed(() =>
	healthOf({ conn: store.conn, piState: store.piState, exitInfo: store.exitInfo, reconnectIn: store.reconnectIn }),
);
/** The id of the other tab that holds the write pen, or null when this tab is free to write. */
const otherWriter = computed(() => {
	const holder = store.writer?.holder ?? null;
	return holder && holder !== store.clientId ? holder : null;
});

/** Drawer headings are proper names, not the internal keys. */
const DRAWER_TITLES: Record<string, string> = {
	files: "Files",
	git: "Git",
	shell: "Shell",
	preview: "Preview",
	settings: "Settings",
};

const TABS = [
	{ key: "files", label: "Files" },
	// Changes / History / Branches are all git; they are sub-tabs inside this drawer, not three
	// peers of Files and Settings in the top bar.
	{ key: "git", label: "Git" },
	// The shell is its own place, next to Git, not a form buried in the settings page.
	{ key: "shell", label: "Shell" },
	{ key: "preview", label: "Preview" },
	{ key: "settings", label: "Settings" },
] as const;

const SETTINGS_TABS = [
	{ key: "model", label: "Model" },
	{ key: "credentials", label: "Credentials" },
	{ key: "commands", label: "Commands" },
	{ key: "session", label: "Session" },
	{ key: "checkpoints", label: "Checkpoints" },
	{ key: "config", label: "Config" },
] as const;

const GIT_TABS = [
	{ key: "changes", label: "Changes" },
	{ key: "history", label: "History" },
	{ key: "branches", label: "Branches" },
] as const;

/** Open a drawer (and load what it shows). The click path and deep links share this. */
function openDrawer(key: "files" | "git" | "shell" | "preview" | "settings"): void {
	store.drawer = key;
	if (key === "preview") store.showPreview = true;
	if (key === "files") store.loadTree(store.cwd);
	if (key === "git") store.refreshGit();
	if (key === "settings") store.setSettingsTab(store.settingsTab);
}

function toggleDrawer(key: string): void {
	if (key === "preview") {
		store.showPreview = store.drawer === "preview" ? false : true;
		store.drawer = store.drawer === "preview" ? "none" : "preview";
		return;
	}
	if (store.drawer === key) {
		store.drawer = "none";
		return;
	}
	openDrawer(key as "files" | "git" | "shell" | "settings");
}

/**
 * Deep links: `?dir=` opens a workspace, `?file=` shows one file in the files drawer, and
 * `?drawer=files|git|shell|preview|settings` (with `?gitTab=` / `?settingsTab=`) opens a drawer —
 * which also makes a layout state reachable from a URL instead of only by clicking.
 */
function applyDeepLink(): void {
	const params = new URLSearchParams(location.search);
	const dir = params.get("dir");
	if (dir) store.openFolder(dir);
	const file = params.get("file");
	if (file) {
		store.drawer = "files";
		store.openFileAt(file);
	}
	const drawer = params.get("drawer");
	if (drawer === "files" || drawer === "git" || drawer === "shell" || drawer === "preview" || drawer === "settings") {
		openDrawer(drawer);
	}
	const gitTab = params.get("gitTab");
	if (gitTab === "changes" || gitTab === "history" || gitTab === "branches") store.setGitTab(gitTab);
	const settingsTab = params.get("settingsTab");
	if (settingsTab === "model" || settingsTab === "credentials" || settingsTab === "commands" || settingsTab === "session" || settingsTab === "checkpoints" || settingsTab === "config") {
		store.setSettingsTab(settingsTab);
	}
}

onMounted(() => {
	applyDrawerWidth();
	store.connect();
	store.listenForPicks();
	store.loadWorkspacesOnce();
	applyDeepLink();
});
</script>

<template>
	<div class="app">
		<header class="topbar">
			<button class="btn btn-ghost btn-sm" :title="sidebarOpen ? 'Hide tasks' : 'Show tasks'" @click="sidebarOpen = !sidebarOpen">☰</button>
			<!--
				The single workspace entry point: it carries the current folder, and opening it
				offers browse / recent / switch / close. The sidebar used to repeat it as an
				"Open folder…" button calling the same action.
			-->
			<button
				class="btn btn-sm dir-btn"
				:title="store.cwd ? `${store.cwd} — open, switch or close a folder` : 'Open a folder'"
				@click="store.openFolderPicker()"
			>
				<span class="dir-name">{{ cwdLabel }}</span>
				<span class="caret">▾</span>
			</button>
			<!--
				One health indicator instead of two chips that both read "fine" when everything is
				fine: the browser↔service socket and the pi child process. It names the specific
				problem when there is one, and stays quiet otherwise.
			-->
			<span class="health" :class="health.class" :title="health.title">
				<span class="dot" />{{ health.label }}
			</span>
			<span v-if="store.running" class="chip chip-warn">working…</span>
			<span v-if="store.pendingUi.length" class="chip chip-danger">{{ store.pendingUi.length }} approval(s)</span>
			<!--
				Writes belong to one tab at a time. When another tab holds the pen, say so and offer the
				explicit takeover instead of letting the next write fail for no visible reason.
			-->
			<span v-if="otherWriter" class="chip chip-warn" :title="`another tab (${otherWriter}) has been writing here since ${store.writer?.since ?? 'unknown'} — reads still work here`">
				another tab is writing
				<button class="btn btn-sm" type="button" title="take over from that tab" @click="store.claimWriter(true)">take over</button>
			</span>
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
				<h4>Sessions</h4>
				<div class="side-list">
					<div
						v-for="session in store.sessions"
						:key="session.path"
						class="side-item"
						:class="{ active: session.path === store.currentSessionPath }"
					>
						<button class="side-open" @click="store.switchSession(session.path)">
							<span class="side-title" :title="session.name || session.firstPrompt || session.id">{{ session.name || session.firstPrompt || session.id }}</span>
							<span class="tiny faint">{{ new Date(session.updatedAt).toLocaleString() }} · {{ session.messageCount }} msg</span>
						</button>
						<!-- Deleting a conversation is destructive: the first click asks, the second does it. -->
						<template v-if="store.sessionDeletePending === session.path">
							<button class="btn btn-sm btn-danger" title="Delete this session file" @click="store.deleteSession(session.path)">Delete</button>
							<button class="btn btn-sm btn-ghost" @click="store.confirmDeleteSession(null)">Cancel</button>
						</template>
						<button
							v-else
							class="side-del"
							:title="session.path === store.currentSessionPath ? 'This session is open — switch to another one before deleting it' : 'Delete this session'"
							@click.stop="store.confirmDeleteSession(session.path)"
						>
							×
						</button>
					</div>
					<p v-if="!store.cwd" class="tiny faint">Open a folder to see its sessions.</p>
					<p v-else-if="!store.sessions.length" class="tiny faint">No sessions for this directory yet.</p>
				</div>
				<div class="col">
					<span class="tiny faint ellipsis mono" :title="store.cwd || 'no folder open'">
						{{ store.cwd || "(no folder)" }}<template v-if="store.workspaces.length > 1"> · +{{ store.workspaces.length - 1 }} open</template>
					</span>
					<span class="tiny faint ellipsis">session: {{ store.sessionName || "(unnamed)" }}</span>
					<button class="btn btn-sm btn-ghost" @click="store.listSessions()">Refresh sessions</button>
				</div>
			</aside>

			<main class="main">
				<div v-if="!store.cwd" class="empty-state">
					<h2>No folder open</h2>
					<p class="dim">
						pi works inside a directory, and every session belongs to one. Open the folder you want to work in — nothing is read until you do.
					</p>
					<button class="btn btn-primary" @click="store.openFolderPicker()">Open folder…</button>
				</div>
				<MessageList v-else :messages="store.messages" :tools="store.tools" />
				<footer v-if="store.retry" class="banner row">
					<span class="chip chip-warn">retry {{ store.retry.attempt }}/{{ store.retry.max }}</span>
					<span class="ellipsis">{{ store.retry.reason }}</span>
				</footer>
				<footer v-if="store.notice" class="banner row">
					<span class="chip chip-warn">notice</span>
					<span class="err-body">{{ store.notice }}</span>
					<button class="btn btn-sm btn-ghost" @click="store.clearNotice()">Dismiss</button>
				</footer>
				<footer v-if="store.lastError" class="banner row">
					<span class="chip chip-danger">error</span>
					<span v-if="store.lastErrorAt" class="tiny faint">{{ store.lastErrorAt }}</span>
					<span class="err-body">{{ store.lastError }}</span>
					<button v-if="store.running" class="btn btn-sm" @click="store.abort()">Stop the run</button>
					<button class="btn btn-sm btn-ghost" @click="store.clearError()">Dismiss</button>
				</footer>
				<Composer
					v-if="store.cwd"
					:running="store.running"
					:queue-steering="store.queueSteering"
					:queue-follow-up="store.queueFollowUp"
					:draft="store.composerDraft"
					:draft-seq="store.composerSeq"
					@prompt="store.sendPrompt($event)"
					@steer="store.steer($event)"
					@abort="store.abort()"
					@clear-queue="store.clearQueue()"
					@notice="store.notice = $event"
				/>
				<div v-if="store.cwd" style="padding: 0 20px 8px">
					<StatusBar />
				</div>
			</main>

			<aside v-if="store.drawer !== 'none'" class="drawer">
				<div
					class="resizer"
					role="separator"
					aria-orientation="vertical"
					tabindex="0"
					title="Drag or use ← / → to resize · double-click or Home to reset"
					@pointerdown="startResize"
					@dblclick="resetDrawerWidth"
					@keydown="onResizeKey"
				/>
				<div class="drawer-head">
					<strong class="small">{{ DRAWER_TITLES[store.drawer] ?? store.drawer }}</strong>
					<span class="spacer" />
					<button class="btn btn-ghost btn-sm" @click="store.drawer = 'none'">×</button>
				</div>
				<div v-if="store.drawer === 'settings'" class="subtabs">
					<button
						v-for="tab in SETTINGS_TABS"
						:key="tab.key"
						class="tab tab-sm"
						:class="{ active: store.settingsTab === tab.key }"
						@click="store.setSettingsTab(tab.key)"
					>
						{{ tab.label }}
					</button>
				</div>
				<div v-if="store.drawer === 'git'" class="subtabs">
					<button
						v-for="tab in GIT_TABS"
						:key="tab.key"
						class="tab tab-sm"
						:class="{ active: store.gitTab === tab.key }"
						@click="store.setGitTab(tab.key)"
					>
						{{ tab.label }}
					</button>
				</div>
				<div class="drawer-body">
					<FilePanel v-if="store.drawer === 'files'" />
					<ChangesPanel v-else-if="store.drawer === 'git' && store.gitTab === 'changes'" />
					<HistoryPanel v-else-if="store.drawer === 'git' && store.gitTab === 'history'" />
					<BranchPanel v-else-if="store.drawer === 'git' && store.gitTab === 'branches'" />
					<ShellPanel v-else-if="store.drawer === 'shell'" />
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
