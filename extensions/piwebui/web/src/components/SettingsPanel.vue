<script setup lang="ts">
/**
 * Settings drawer: model / thinking / behaviour, discoverable commands, session tools, shell
 * and the allowlisted config files. Every button is a real RPC command or HTTP endpoint.
 */
import { computed, onMounted, ref } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const renameDraft = ref("");
const filter = ref("");

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
		<pre v-if="statsLines.length" class="code-block">{{ statsLines.join("\n") }}</pre>
		<div v-for="point in store.forkPoints" :key="point.entryId" class="row">
			<button class="btn btn-sm" @click="store.forkFrom(point.entryId)">Fork</button>
			<span class="tiny faint ellipsis">{{ (point.text || point.preview || point.entryId).slice(0, 120) }}</span>
		</div>
		<pre v-if="store.tree.length" class="code-block">{{ JSON.stringify(store.tree, null, 1).slice(0, 4000) }}</pre>
		<pre v-if="store.lastAssistantText" class="code-block">{{ store.lastAssistantText.slice(0, 4000) }}</pre>

		<!-- shell -->
		<h4>Shell</h4>
		<p class="fact tiny">Runs through pi's <code>bash</code> command (the TUI's <code>!</code>). Output reaches the model on the next prompt unless excluded.</p>
		<div class="row-nowrap">
			<input v-model="store.shellCommand" class="field" placeholder="ls -la" @keydown.enter="store.runBash()" />
			<button class="btn btn-sm" :disabled="!store.shellCommand.trim() || store.shellRunning" @click="store.runBash()">Run</button>
			<button class="btn btn-sm" :disabled="!store.shellRunning" @click="store.abortBash()">Abort</button>
		</div>
		<div class="row">
			<label class="row tiny"><input v-model="store.shellExcluded" type="checkbox" /><span>exclude from context</span></label>
			<span v-if="store.shellExitCode !== null" class="chip">exit {{ store.shellExitCode }}</span>
			<span v-if="store.shellRunning" class="chip chip-warn">running</span>
		</div>
		<pre v-if="store.shellOutput" class="code-block">{{ store.shellOutput.slice(-8000) }}</pre>

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
