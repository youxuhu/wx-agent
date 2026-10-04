<script setup lang="ts">
/**
 * Settings drawer: model / thinking / behaviour, discoverable commands, session tools, shell
 * and the allowlisted config files. Every button is a real RPC command or HTTP endpoint.
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const renameDraft = ref("");
const filter = ref("");
const authProvider = ref("");
const authKey = ref("");
const defaultProvider = ref("");
const defaultModel = ref("");

const oauthProviders = computed(() => store.authProviders.filter((entry) => entry.kind === "oauth").map((entry) => entry.provider));

const TREE_LIMIT = 20_000;
const treeText = computed(() => {
	const text = JSON.stringify(store.tree, null, 1);
	return text.length > TREE_LIMIT ? text.slice(0, TREE_LIMIT) : text;
});
const treeTrimmed = computed(() => JSON.stringify(store.tree, null, 1).length > TREE_LIMIT);

function saveKey(): void {
	const provider = authProvider.value.trim();
	const key = authKey.value;
	if (!provider || !key.trim()) return;
	store.saveApiKey(provider, key);
	authKey.value = "";
}

function loadDefaults(): void {
	void fetch("/api/config")
		.then((response) => response.json())
		.then((config: { files?: Array<{ name: string; content: string }> }) => {
			const file = config.files?.find((entry) => entry.name === "settings.json");
			if (!file) return;
			const parsed = JSON.parse(file.content) as { defaultProvider?: string; defaultModel?: string };
			defaultProvider.value = parsed.defaultProvider ?? "";
			defaultModel.value = parsed.defaultModel ?? "";
		})
		.catch(() => undefined);
}

function copy(text: string): void {
	void navigator.clipboard?.writeText(text);
}

/** Keep the newest shell output in view. */

const statsLines = computed(() => {
	const stats = store.stats;
	if (!stats) return [];
	const tokens = stats.tokens ?? {};
	return [
		`session ${stats.sessionId ?? "?"}`,
		`messages user ${stats.userMessages ?? 0} · assistant ${stats.assistantMessages ?? 0} · tools ${stats.toolCalls ?? 0} · total ${stats.totalMessages ?? 0}`,
		`tokens in ${tokens.input ?? 0} · out ${tokens.output ?? 0} · cache read ${tokens.cacheRead ?? 0} · cache write ${tokens.cacheWrite ?? 0}`,
		`cost ${stats.cost ?? 0}`,
		`context ${JSON.stringify(stats.contextUsage ?? {})}`,
	];
});

const sessionRows = computed(() =>
	store.sessions.map((session) => ({
		...session,
		isCurrent: session.path === store.currentSessionPath,
		title: session.name || session.firstPrompt || session.id,
	})),
);

function rename(): void {
	const name = renameDraft.value.trim();
	if (!name) return;
	store.renameSession(name);
	renameDraft.value = "";
}

onMounted(() => {
	store.loadAuth();
	loadDefaults();
	if (!store.commands.length) store.requestCommands();
	if (!store.models.length) store.requestModels();
	if (!store.thinkingLevels.length) store.requestThinkingLevels();
	if (!store.configFiles.length) store.loadConfigFiles();
	store.listSessions();
});
</script>

<template>
	<div class="pane">
		<!-- model & behaviour -->
		<h4>Model</h4>
		<div class="row">
			<span class="chip">{{ store.model || "(pi default)" }}</span>
			<span class="chip">thinking: {{ store.thinkingLevel || "?" }}</span>
			<button class="btn btn-sm" @click="store.cycleModel()">Cycle model</button>
			<button class="btn btn-sm" @click="store.cycleThinking()">Cycle thinking</button>
		</div>
		<div class="row">
			<button v-for="level in store.thinkingLevels" :key="level" class="tab" :class="{ active: store.thinkingLevel === level }" @click="store.setThinking(level)">
				{{ level }}
			</button>
			<span v-if="!store.thinkingLevels.length" class="tiny faint">thinking levels not loaded</span>
		</div>
		<div class="row">
			<label class="row tiny"><input :checked="store.autoCompaction ?? false" type="checkbox" @change="store.setAutoCompaction(($event.target as HTMLInputElement).checked)" /><span>auto-compaction</span></label>
			<label class="row tiny"><input :checked="store.autoRetry ?? false" type="checkbox" @change="store.setAutoRetry(($event.target as HTMLInputElement).checked)" /><span>auto-retry</span></label>
			<button class="btn btn-sm btn-ghost" @click="store.send({ type: 'abort_retry' })">Abort retry</button>
		</div>
		<div class="row">
			<span class="tiny dim">steering</span>
			<button v-for="mode in ['all', 'one-at-a-time']" :key="mode" class="tab" :class="{ active: store.steeringMode === mode }" @click="store.setSteeringMode(mode)">
				{{ mode }}
			</button>
			<span class="tiny dim">follow-up</span>
			<button v-for="mode in ['one-at-a-time', 'all']" :key="mode" class="tab" :class="{ active: store.followUpMode === mode }" @click="store.setFollowUpMode(mode)">
				{{ mode }}
			</button>
		</div>

		<h4>Providers &amp; credentials</h4>
		<p class="fact tiny">
			Equivalent of the terminal's <code>/login</code> for API keys: set or rotate a key here, or remove one. Values are
			<strong>never</strong> read back into the browser — only "configured / not configured" is shown. OAuth providers
			({{ oauthProviders.length ? oauthProviders.join(", ") : "none" }}) still need <code>/login &lt;provider&gt;</code> in the terminal, and
			environment variables also work as a fallback.
		</p>
		<div class="row-nowrap">
			<input v-model="authProvider" class="field" list="known-providers" placeholder="provider id, e.g. deepseek" />
			<datalist id="known-providers">
				<option v-for="entry in store.authProviders" :key="entry.provider" :value="entry.provider" />
			</datalist>
			<input v-model="authKey" class="field" type="password" placeholder="API key (written to auth.json, 0600)" @keydown.enter="saveKey()" />
			<button class="btn btn-sm btn-primary" :disabled="store.authBusy || !authProvider.trim() || !authKey.trim()" @click="saveKey()">Save key</button>
		</div>
		<div class="list">
			<div v-for="entry in store.authProviders" :key="entry.provider" class="list-row">
				<span class="mono">{{ entry.provider }}</span>
				<span class="chip" :class="entry.hasSecret ? 'chip-ok' : ''">{{ entry.kind }}{{ entry.hasSecret ? "" : " (empty)" }}</span>
				<button class="btn btn-sm btn-ghost" @click="authProvider = entry.provider">Use</button>
				<span class="spacer" />
				<button class="btn btn-sm btn-ghost btn-danger" :disabled="store.authBusy" @click="store.removeCredential(entry.provider)">Remove</button>
			</div>
			<div v-if="!store.authProviders.length" class="list-row faint">no stored credentials yet</div>
		</div>
		<p v-if="store.authStatus" class="fact">{{ store.authStatus }}</p>
		<p v-if="store.authNote" class="fact tiny faint">{{ store.authNote }}</p>

		<h4>Default model</h4>
		<p class="fact tiny">Written to <code>settings.json</code> (<code>defaultProvider</code> / <code>defaultModel</code>); new sessions pick it up.</p>
		<div class="row-nowrap">
			<input v-model="defaultProvider" class="field" placeholder="provider, e.g. deepseek" />
			<input v-model="defaultModel" class="field" placeholder="model, e.g. deepseek-flash" />
			<button class="btn btn-sm" @click="store.applyDefaultModel(defaultProvider, defaultModel)">Save defaults</button>
			<button class="btn btn-sm btn-ghost" @click="loadDefaults()">Load current</button>
		</div>
		<p v-if="store.defaultModelStatus" class="fact">{{ store.defaultModelStatus }}</p>

		<details>
			<summary class="tiny dim">available models ({{ store.models.length }})</summary>
			<button class="btn btn-sm" @click="store.requestModels()">Reload models</button>
			<div class="list" style="max-height: 30vh">
				<div v-for="model in store.models" :key="`${model.provider}/${model.id}`" class="list-row clickable" @click="store.setModel(model.provider, model.id)">
					<span class="mono tiny">{{ model.provider }}/{{ model.id }}</span>
					<span class="tiny faint ellipsis">{{ model.name || "" }}</span>
				</div>
			</div>
		</details>

		<!-- commands -->
		<h4>Commands · {{ store.commands.length }}</h4>
		<p class="fact tiny">
			Discovered from pi (extensions, prompt templates, skills). Clicking puts <code>/name</code> into the composer; built-in TUI-only commands are
			not listed and do not run over RPC.
		</p>
		<div class="row">
			<button class="btn btn-sm" @click="store.requestCommands()">Reload</button>
			<input class="field" style="max-width: 220px" placeholder="filter commands…" @input="(e) => (filter = (e.target as HTMLInputElement).value)" />
		</div>
		<div class="list" style="max-height: 30vh">
			<div
				v-for="command in store.commands.filter((c) => !filter || c.name.includes(filter))"
				:key="command.name"
				class="list-row clickable"
				@click="store.insertCommand(command.name)"
			>
				<span class="chip">{{ command.source }}</span>
				<span class="mono">/{{ command.name }}</span>
				<span class="tiny faint ellipsis">{{ command.description || "" }}</span>
			</div>
		</div>

		<!-- sessions -->
		<h4>Sessions</h4>
		<div class="row">
			<button class="btn btn-sm" @click="store.newSession()">New session</button>
			<button class="btn btn-sm" @click="store.listSessions()">Refresh</button>
			<button class="btn btn-sm" @click="store.compact()">Compact</button>
			<span class="chip">{{ sessionRows.length }} in {{ store.cwd }}</span>
		</div>
		<div class="row-nowrap">
			<input v-model="renameDraft" class="field" :placeholder="store.sessionName || 'rename current session…'" @keydown.enter="rename()" />
			<button class="btn btn-sm" :disabled="!renameDraft.trim()" @click="rename()">Rename</button>
		</div>
		<div class="list" style="max-height: 34vh">
			<div v-for="row in sessionRows" :key="row.path" class="list-row clickable" :class="{ active: row.isCurrent }" @click="store.switchSession(row.path)">
				<span class="chip" :class="row.isCurrent ? 'chip-ok' : ''">{{ row.isCurrent ? "current" : "switch" }}</span>
				<span class="ellipsis">{{ row.title }}</span>
				<span class="spacer" />
				<span class="tiny faint">{{ row.messageCount }} msg · {{ Math.max(1, Math.round(row.sizeBytes / 1024)) }}KB</span>
			</div>
			<div v-if="!sessionRows.length" class="list-row faint">no sessions for this directory yet</div>
		</div>

		<!-- session tools -->
		<h4>Session tools</h4>
		<div class="row">
			<button class="btn btn-sm" @click="store.requestStats()">Stats</button>
			<button class="btn btn-sm" @click="store.requestTree()">Tree</button>
			<button class="btn btn-sm" @click="store.requestForkPoints()">Fork points</button>
			<button class="btn btn-sm" @click="store.cloneSession()">Clone</button>
			<button class="btn btn-sm" @click="store.exportHtml()">Export HTML</button>
			<button class="btn btn-sm" @click="store.copyLastAssistant()">Last assistant text</button>
		</div>
		<div v-if="statsLines.length" class="output">
			<div class="output-head"><span>stats</span><span class="spacer" /><button class="btn btn-sm btn-ghost" @click="copy(statsLines.join('\n'))">Copy</button></div>
			<pre class="code-block">{{ statsLines.join("\n") }}</pre>
		</div>
		<div v-for="point in store.forkPoints" :key="point.entryId" class="row">
			<button class="btn btn-sm" @click="store.forkFrom(point.entryId)">Fork</button>
			<span class="tiny faint ellipsis">{{ (point.text || point.preview || point.entryId).slice(0, 120) }}</span>
		</div>
		<div v-if="store.tree.length" class="output">
			<div class="output-head">
				<span>session tree · {{ treeText.length }} chars<template v-if="treeTrimmed"> (showing first 20000)</template></span>
				<span class="spacer" />
				<button class="btn btn-sm btn-ghost" @click="copy(treeText)">Copy</button>
			</div>
			<pre class="code-block">{{ treeText }}</pre>
		</div>
		<div v-if="store.lastAssistantText" class="output">
			<div class="output-head">
				<span>last assistant text · {{ store.lastAssistantText.length }} chars</span>
				<span class="spacer" />
				<button class="btn btn-sm btn-ghost" @click="copy(store.lastAssistantText)">Copy</button>
				<button class="btn btn-sm btn-ghost" @click="store.insertIntoPrompt(store.lastAssistantText)">Insert into prompt</button>
			</div>
			<pre class="code-block">{{ store.lastAssistantText }}</pre>
		</div>

		<!-- config -->
		<h4>Config files</h4>
		<p class="fact tiny">Only the allowlist is readable and writable; <code>auth.json</code> is never exposed. Saves validate JSON, keep the previous content as <code>.bak</code>, and need <code>/reload</code> (or a restart) to take effect.</p>
		<div class="row">
			<button
				v-for="file in store.configFiles"
				:key="file.name"
				class="tab"
				:class="{ active: store.configName === file.name }"
				@click="store.pickConfig(file.name)"
			>
				{{ file.name }}<span v-if="!file.exists" class="faint"> (absent)</span>
			</button>
			<button class="btn btn-sm btn-ghost" @click="store.loadConfigFiles()">Reload list</button>
		</div>
		<textarea v-if="store.configName" v-model="store.configDraft" class="textarea" :rows="14" />
		<div v-if="store.configName" class="row">
			<button class="btn btn-sm btn-primary" @click="store.saveConfig()">Save {{ store.configName }}</button>
			<span class="tiny faint">{{ store.configDraft.length }} chars</span>
		</div>
		<p v-if="store.configStatus" class="fact">{{ store.configStatus }}</p>
	</div>
</template>
