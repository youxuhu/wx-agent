/**
 * Execution engine over the pi-subagents in-process RPC bus (public seam):
 *   ready   : subagents:rpc:v1:ready
 *   request : subagents:rpc:v1:request        reply: subagents:rpc:v1:reply:<requestId>
 *   complete: subagent:async-complete          (process-local, carries runId)
 * Spawn goes through the same executor as the subagent tool; spawn is async-only,
 * so a serial lane = spawn → await completion → inject upstream → spawn next.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTask, type Pipeline, type Step } from "./model.ts";

const READY = "subagents:rpc:v1:ready";
const REQUEST = "subagents:rpc:v1:request";
const replyChannel = (id: string) => `subagents:rpc:v1:reply:${id}`;
const ASYNC_COMPLETE = "subagent:async-complete";

export type StepState = "queued" | "running" | "done" | "failed" | "stopped";

export interface StepRun {
	state: StepState;
	runId?: string;
	startedAt?: number;
	elapsedMs?: number;
	error?: string;
	output?: string;
}

export interface ChainHooks {
	onUpdate(): void;
	onLog(line: string): void;
}

export class OrchestraRunner {
	private pi: ExtensionAPI;
	private ready = false;
	private readyWaiters: (() => void)[] = [];
	private unsubs: (() => void)[] = [];
	/** runId → completion payload (populated by the async-complete listener) */
	private completions = new Map<string, Record<string, unknown>>();
	runs = new Map<string, StepRun>(); // step.id → run state

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.unsubs.push(
			pi.events.on(READY, () => {
				this.ready = true;
				const waiters = this.readyWaiters;
				this.readyWaiters = [];
				for (const w of waiters) w();
			}),
		);
		this.unsubs.push(
			pi.events.on(ASYNC_COMPLETE, (data) => {
				const payload = data as Record<string, unknown>;
				const runId = typeof payload?.runId === "string" ? payload.runId : undefined;
				if (runId) {
					this.completions.set(runId, payload);
					// wake anyone waiting on this run
					const w = this.completionWaiters.get(runId);
					if (w) {
						this.completionWaiters.delete(runId);
						w();
					}
				}
			}),
		);
	}

	private completionWaiters = new Map<string, () => void>();

	/** Wait until the pi-subagents RPC bus announces readiness. */
	async ensureReady(timeoutMs = 10_000): Promise<void> {
		if (this.ready) return;
		if (await this.ping(2000)) {
			this.ready = true;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("orchestra: pi-subagents RPC not ready (timeout)")), timeoutMs);
			this.readyWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private ping(timeoutMs: number): Promise<boolean> {
		return this.rpc("ping", {}, timeoutMs).then(
			() => true,
			() => false,
		);
	}

	/** One request/response round-trip on the bus. */
	private rpc(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> {
		const requestId = `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`orchestra: rpc ${method} timed out`));
			}, timeoutMs);
			const cleanup = this.pi.events.on(replyChannel(requestId), (data) => {
				const reply = data as { success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
				clearTimeout(timer);
				cleanup();
				if (reply?.success) resolve(reply.data ?? {});
				else reject(new Error(`orchestra: rpc ${method} failed: ${reply?.error?.message ?? "unknown error"}`));
			});
			this.pi.events.emit(REQUEST, { version: 1, requestId, method, params });
		});
	}

	/**
	 * Spawn one step. Returns the runId. Tolerant of params the installed
	 * pi-subagents build rejects: unknown fields are dropped and the spawn is
	 * retried with the minimal {agent, task} contract.
	 */
	private async spawnStep(step: Step, task: string): Promise<string> {
		const base = { agent: step.role, task, async: true };
		const extra = {
			...(step.worktree ? { worktree: true, isolation: "worktree" } : {}),
			...(step.agentOverrides ?? {}),
		};
		try {
			const data = await this.rpc("spawn", { ...base, ...extra });
			return requireRunId(data);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (Object.keys(extra).length === 0) throw e;
			this.completions.set(`__spawnErr:${step.id}`, { error: msg });
			const data = await this.rpc("spawn", base); // minimal retry
			return requireRunId(data);
		}
	}

	/** Await async completion for a runId (event-driven; status fallback once). */
	private async awaitCompletion(runId: string, hooks: ChainHooks, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const existing = this.completions.get(runId);
		if (existing) return existing;
		await new Promise<void>((resolve) => {
			const timer = setInterval(async () => {
				if (signal?.aborted) {
					clearInterval(timer);
					resolve();
					return;
				}
				try {
					const st = await this.rpc("status", { id: runId }, 20_000);
					const runStatus = String((st as { runStatus?: string; runMode?: string }).runStatus ?? "");
					if (/complete|failed|stopped|error/i.test(runStatus)) {
						clearInterval(timer);
						this.completions.set(runId, { __fromStatus: true, runStatus, ...st });
						resolve();
					} else if (runStatus) {
						hooks.onLog(`status ${runId}: ${runStatus}`);
					}
				} catch {
					/* status probe failure is non-fatal; the completion event remains authoritative */
				}
			}, 3000);
			this.completionWaiters.set(runId, () => {
				clearInterval(timer);
				resolve();
			});
			if (signal) {
				const onAbort = () => {
					clearInterval(timer);
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		return this.completions.get(runId) ?? {};
	}

	/** Extract the child's output text from a completion payload (defensive shape). */
	private extractOutput(payload: Record<string, unknown>): string {
		if (typeof payload.text === "string" && payload.text.trim()) return payload.text;
		if (typeof payload.output === "string" && payload.output.trim()) return payload.output;
		const results = payload.results as Record<string, unknown>[] | undefined;
		if (Array.isArray(results)) {
			for (const r of results) {
				if (typeof r.output === "string" && r.output.trim()) return r.output;
				if (typeof r.structuredOutputText === "string" && r.structuredOutputText.trim()) return r.structuredOutputText;
			}
		}
		const so = payload.structuredOutput;
		if (typeof so === "string" && so.trim()) return so;
		if (so && typeof so === "object") {
			try {
				return JSON.stringify(so, null, 2);
			} catch {
				/* fallthrough */
			}
		}
		return "";
	}

	/** Run the whole lane serially (parallel:true steps batch with the previous one). */
	async runChain(pipeline: Pipeline, hooks: ChainHooks, signal?: AbortSignal): Promise<Map<string, StepRun>> {
		const upstreamCarry: { text: string | null } = { text: null };
		let i = 0;
		while (i < pipeline.steps.length) {
			if (signal?.aborted) break;
			// batch: this step + following parallel:true steps run together
			const batch: Step[] = [pipeline.steps[i]];
			let j = i + 1;
			while (j < pipeline.steps.length && pipeline.steps[j].parallel) {
				batch.push(pipeline.steps[j]);
				j++;
			}
			const outputs = await Promise.all(batch.map((step) => this.runStep(step, upstreamCarry.text, hooks, signal)));
			const texts = outputs.map((o) => o.output).filter((t): t is string => Boolean(t && t.trim()));
			upstreamCarry.text = texts.length ? texts.join("\n\n") : null;
			i = j;
		}
		return this.runs;
	}

	async runStep(step: Step, upstream: string | null, hooks: ChainHooks, signal?: AbortSignal): Promise<StepRun> {
		const run: StepRun = this.runs.get(step.id) ?? { state: "queued" };
		this.runs.set(step.id, run);
		if (run.state === "done" || run.state === "running") return run; // resume support: keep completed steps
		const task = buildTask(step, upstream);
		run.state = "running";
		run.startedAt = Date.now();
		run.error = undefined;
		hooks.onUpdate();
		try {
			const runId = await this.spawnStep(step, task);
			run.runId = runId;
			hooks.onLog(`spawned ${step.role} (${step.title}) → ${runId}`);
			const payload = await this.awaitCompletion(runId, hooks, signal);
			run.elapsedMs = Date.now() - (run.startedAt ?? 0);
			const state = String(payload.state ?? payload.runStatus ?? "");
			if (/fail|error/i.test(state)) {
				run.state = "failed";
				run.error = typeof payload.error === "string" ? payload.error : `state=${state}`;
			} else if (/stop/i.test(state)) {
				run.state = "stopped";
			} else if (signal?.aborted && !payload.runId && !state) {
				run.state = "stopped";
			} else {
				run.state = "done";
				run.output = this.extractOutput(payload);
			}
		} catch (e) {
			run.state = "failed";
			run.error = e instanceof Error ? e.message : String(e);
		}
		hooks.onUpdate();
		return run;
	}

	async steer(stepId: string, message: string): Promise<string> {
		const run = this.runs.get(stepId);
		if (!run?.runId) throw new Error("orchestra: step has no run to steer");
		const data = await this.rpc("steer", { id: run.runId, message });
		return typeof data.deliveryStatus === "string" ? data.deliveryStatus : "unknown";
	}

	async stop(stepId: string): Promise<void> {
		const run = this.runs.get(stepId);
		if (!run?.runId) throw new Error("orchestra: step has no run to stop");
		await this.rpc("stop", { id: run.runId });
	}

	dispose(): void {
		for (const u of this.unsubs) u();
		this.unsubs = [];
	}
}

function requireRunId(data: Record<string, unknown>): string {
	const id = data.runId ?? data.id;
	if (typeof id !== "string" || !id) throw new Error("orchestra: spawn returned no runId");
	return id;
}
