<script setup lang="ts">
/**
 * Control drawer: everything the terminal UI can drive, driven from the browser.
 *
 * Each tab maps to real RPC commands (`get_commands`, `get_available_models`,
 * `set_thinking_level`, `get_tree`, `fork`, `bash`, …). Facts only: responses and
 * refusals are printed as they arrive, and nothing is retried or guessed.
 */
import { computed, onMounted, watch } from "vue";
import { Button, Divider, Drawer, Input, Space, Switch, Tag, Textarea } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();

const TABS = ["commands", "model", "session", "shell", "config"] as const;
const STEERING_MODES = ["all", "one-at-a-time"];
const FOLLOW_UP_MODES = ["one-at-a-time", "all"];

const statsLines = computed(() => {
	const stats = store.stats;
	if (!stats) return [];
	const tokens = stats.tokens ?? {};
	return [
		`session: ${stats.sessionId ?? "?"} · ${stats.sessionFile ?? "?"}`,
		`messages: user ${stats.userMessages ?? 0} · assistant ${stats.assistantMessages ?? 0} · tools ${stats.toolCalls ?? 0} · total ${stats.totalMessages ?? 0}`,
		`tokens: in ${tokens.input ?? 0} · out ${tokens.output ?? 0} · cache read ${tokens.cacheRead ?? 0} · cache write ${tokens.cacheWrite ?? 0} · total ${tokens.total ?? 0}`,
		`cost: ${stats.cost ?? 0}`,
		`context: ${JSON.stringify(stats.contextUsage ?? {})}`,
	];
});

function onTab(tab: string): void {
	store.controlTab = tab;
	if (tab === "commands" && !store.commands.length) store.requestCommands();
	if (tab === "model") {
		if (!store.models.length) store.requestModels();
		if (!store.thinkingLevels.length) store.requestThinkingLevels();
		store.send({ type: "get_state" });
	}
	if (tab === "session") store.requestStats();
	if (tab === "config" && !store.configFiles.length) store.loadConfigFiles();
}

onMounted(() => onTab(store.controlTab));
watch(() => store.showControl, (open) => {
	if (open) onTab(store.controlTab);
});
</script>

<template>
	<Drawer v-model:visible="store.showControl" title="control" placement="right" :width="520">
		<div class="tabs">
			<Button v-for="tab in TABS" :key="tab" size="small" :variant="store.controlTab === tab ? 'primary' : 'outline'" @click="onTab(tab)">
				{{ tab }}
			</Button>
		</div>

		<!-- commands -->
		<section v-if="store.controlTab === 'commands'" class="pane">
			<p class="dim">
				从 pi 枚举出的可调用命令（扩展命令 / 提示模板 / 技能）。点击会把 <code>/name </code> 放进输入框，需要参数时补上再发送；RPC 里扩展命令也可以带参数直接发。
			</p>
			<Space>
				<Button size="small" variant="outline" @click="store.requestCommands()">refresh</Button>
				<Tag size="small">{{ store.commands.length }} commands</Tag>
			</Space>
			<div v-for="command in store.commands" :key="command.name" class="row">
				<Tag size="small" :theme="command.source === 'extension' ? 'success' : 'notice'">{{ command.source }}</Tag>
				<Button size="small" variant="text" @click="store.insertCommand(command.name)">/{{ command.name }}</Button>
				<span class="dim ellipsis">{{ command.description || command.sourceInfo?.path || "" }}</span>
			</div>
			<p v-if="!store.commands.length" class="dim">还没有枚举（点 refresh）。</p>
		</section>

		<!-- model / thinking / modes -->
		<section v-else-if="store.controlTab === 'model'" class="pane">
			<Space>
				<Tag size="small">model: {{ store.model || "(pi default)" }}</Tag>
				<Tag size="small">thinking: {{ store.thinkingLevel || "?" }}</Tag>
				<Button size="small" variant="outline" @click="store.cycleModel()">cycle model</Button>
				<Button size="small" variant="outline" @click="store.cycleThinking()">cycle thinking</Button>
			</Space>
			<Divider />
			<Space wrap>
				<Button v-for="level in store.thinkingLevels" :key="level" size="small" :variant="store.thinkingLevel === level ? 'primary' : 'outline'" @click="store.setThinking(level)">
					{{ level }}
				</Button>
				<span v-if="!store.thinkingLevels.length" class="dim">thinking levels 未加载</span>
			</Space>
			<Divider />
			<div class="row">
				<span class="dim">auto-compaction</span>
				<Switch :model-value="store.autoCompaction ?? false" size="small" @update:model-value="(v: boolean) => store.setAutoCompaction(v)" />
				<span class="dim">auto-retry</span>
				<Switch :model-value="store.autoRetry ?? false" size="small" @update:model-value="(v: boolean) => store.setAutoRetry(v)" />
				<Button size="small" variant="text" @click="store.send({ type: 'abort_retry' })">abort retry</Button>
			</div>
			<div class="row">
				<span class="dim">steering</span>
				<Button v-for="mode in STEERING_MODES" :key="mode" size="small" :variant="store.steeringMode === mode ? 'primary' : 'outline'" @click="store.setSteeringMode(mode)">
					{{ mode }}
				</Button>
				<span class="dim">follow-up</span>
				<Button v-for="mode in FOLLOW_UP_MODES" :key="mode" size="small" :variant="store.followUpMode === mode ? 'primary' : 'outline'" @click="store.setFollowUpMode(mode)">
					{{ mode }}
				</Button>
			</div>
			<Divider />
			<Space>
				<Button size="small" variant="outline" @click="store.requestModels()">refresh models</Button>
				<Tag size="small">{{ store.models.length }}</Tag>
			</Space>
			<div v-for="model in store.models" :key="`${model.provider}/${model.id}`" class="row">
				<Button size="small" variant="text" @click="store.setModel(model.provider, model.id)">
					{{ model.provider }}/{{ model.id }}
				</Button>
				<span class="dim">{{ model.name || "" }}</span>
			</div>
		</section>

		<!-- session tools -->
		<section v-else-if="store.controlTab === 'session'" class="pane">
			<Space>
				<Button size="small" @click="store.requestStats()">stats</Button>
				<Button size="small" variant="outline" @click="store.requestTree()">tree</Button>
				<Button size="small" variant="outline" @click="store.requestForkPoints()">fork points</Button>
				<Button size="small" variant="outline" @click="store.cloneSession()">clone session</Button>
				<Button size="small" variant="outline" @click="store.exportHtml()">export html</Button>
				<Button size="small" variant="outline" @click="store.copyLastAssistant()">last assistant text</Button>
			</Space>
			<pre v-if="statsLines.length" class="log">{{ statsLines.join("\n") }}</pre>
			<pre v-if="store.tree.length" class="log">{{ JSON.stringify(store.tree, null, 1).slice(0, 4000) }}</pre>
			<div v-for="point in store.forkPoints" :key="point.entryId" class="row">
				<Button size="small" variant="outline" @click="store.forkFrom(point.entryId)">fork</Button>
				<span class="dim ellipsis">{{ (point.text || point.preview || point.entryId).slice(0, 120) }}</span>
			</div>
			<pre v-if="store.lastAssistantText" class="log">{{ store.lastAssistantText.slice(0, 4000) }}</pre>
		</section>

		<!-- shell (the TUI's ! escape) -->
		<section v-else-if="store.controlTab === 'shell'" class="pane">
			<p class="dim">
				直接执行 shell 命令（等价于 TUI 的 <code>!</code>）。输出会进会话上下文，除非打开 exclude；下一条 prompt 才会带给模型。
			</p>
			<div class="row">
				<Input v-model="store.shellCommand" size="small" placeholder="ls -la" @keydown.enter="store.runBash()" />
				<Button size="small" :disabled="!store.shellCommand.trim() || store.shellRunning" @click="store.runBash()">run</Button>
				<Button size="small" variant="outline" :disabled="!store.shellRunning" @click="store.abortBash()">abort</Button>
			</div>
			<div class="row">
				<span class="dim">exclude from context</span>
				<Switch v-model="store.shellExcluded" size="small" />
				<Tag v-if="store.shellExitCode !== null" size="small">exit {{ store.shellExitCode }}</Tag>
				<Tag v-if="store.shellRunning" size="small" theme="warning">running</Tag>
			</div>
			<pre v-if="store.shellOutput" class="log">{{ store.shellOutput.slice(-8000) }}</pre>
		</section>

		<!-- config files -->
		<section v-else class="pane">
			<p class="dim">
				读写 pi 的配置文件（仅白名单；<code>auth.json</code> 不暴露）。保存前会校验 JSON，旧内容保留成 <code>.bak</code>；写盘后需在终端 <code>/reload</code> 或重启才生效。
			</p>
			<Space wrap>
				<Button
					v-for="file in store.configFiles"
					:key="file.name"
					size="small"
					:variant="store.configName === file.name ? 'primary' : 'outline'"
					@click="store.pickConfig(file.name)"
				>
					{{ file.name }}<span v-if="!file.exists" class="dim"> (absent)</span>
				</Button>
				<Button size="small" variant="text" @click="store.loadConfigFiles()">reload list</Button>
			</Space>
			<Textarea v-if="store.configName" v-model="store.configDraft" :rows="16" placeholder="{}" />
			<Space v-if="store.configName">
				<Button size="small" @click="store.saveConfig()">save {{ store.configName }}</Button>
				<Tag size="small">{{ store.configDraft.length }} chars</Tag>
			</Space>
			<p v-if="store.configStatus" class="fact">{{ store.configStatus }}</p>
		</section>
	</Drawer>
</template>

<style scoped>
.tabs {
	display: flex;
	gap: 6px;
	margin-bottom: 8px;
}

.pane {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.row {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.ellipsis {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 260px;
}

.log {
	margin: 0;
	max-height: 260px;
	overflow: auto;
	font-size: 12px;
	white-space: pre-wrap;
}

.fact {
	margin: 0;
	font-size: 12px;
}

.dim {
	color: var(--px-neutral-8, #666);
	font-size: 12px;
}
</style>
