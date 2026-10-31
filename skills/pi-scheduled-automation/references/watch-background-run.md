# Watch a Pi background run

Load only for requests to periodically check an existing background task. This recipe covers a `pi-subagents` asynchronous `runId`, not arbitrary OS processes, shell PIDs, CI jobs, or services.

## Before scheduling

1. Obtain the exact `runId`. If missing, ask for it; don't create an empty watcher.
2. Ask/confirm check interval, project `cwd`, what counts as actionable idle time, and whether the user wants an interruption on every successful check or quiet history-only checks.
3. In the current parent session, use `subagent({action:"status", id: runId})` to confirm the run exists and inspect the available lifecycle/activity facts. Lifecycle states include `queued`, `running`, `paused`, `complete`, `stopped`, `failed`, and `rejected`.
4. `needs_attention` is a control/attention event, **not** a lifecycle state. Last observed activity is evidence, not proof that a task is stuck.
5. Confirm the scheduled worker can call the `subagent` status action in its own context. A passing workflow `validate` does not prove child tool access or run visibility. If that capability is unavailable or unclear, do not claim the monitor works; ask for approval to use a different, explicitly supported mechanism.

## Workflow template

Copy [examples/watch-background-run.js](../examples/watch-background-run.js) to `.pi/workflows/watch-background-run.js`. The workflow launches a labeled read-only worker task; this is only a template and must be checked for status-tool access from the scheduled worker context before relying on it.

The child agent's status-tool access and visibility must be proven for this installation/context; static workflow validation is not enough. If using a user-configured agent instead of `worker`, check it exists and has the read-only status capability before scheduling.

Validate:

```ts
subagent({
  action: "validate",
  workflow: "./.pi/workflows/watch-background-run.js",
  args: { runId: "<confirmed-run-id>" },
});
```

Then create one recurring schedule:

```ts
subagent({
  action: "schedule.create",
  id: "watch-<short-run-id>",
  name: "Watch background run <short-run-id>",
  every: "5m",
  catchUp: "latest",
  workflow: "./.pi/workflows/watch-background-run.js",
  args: { runId: "<confirmed-run-id>" },
  cwd: "/absolute/project/path",
});
```

Use a user-agreed cadence; `5m` is only an example. Each poll launches a worker run and can use model/tool resources. Do not create excessively frequent checks.

## Avoiding duplicate notices

Every scheduled fire uses fresh context. Without an attached existing mission, do not promise cross-fire memory or deduplicated notices. If deduplication is needed, create/choose a mission explicitly and pass its `missionId`; store only the last observed lifecycle state, last reported attention event, and relevant timestamps in mission state. Keep fixed `args` immutable and free of secrets. Confirm the mission resolves in the same project/store as the schedule.

The scheduler has no built-in “wake only when the monitored state changes” setting:

- `quiet: true` on a recurring schedule suppresses parent wakeups for successful checks (results remain in schedule history); this may suppress the completion alert the user expects.
- Default/noisy successful checks may wake the parent on every poll, not only on changes.

Explain this tradeoff and let the user choose. Do not imply that a quiet watcher will proactively interrupt the user on successful completion. Failed/stopped/paused outcomes still surface according to scheduler semantics.

## Idle and terminal handling

- A timestamp older than the user-set threshold means “no observed activity for N minutes,” not “stuck.” Report evidence and ask before intervention.
- `paused` means paused, not completed. `needs_attention` is a separate event; surface it distinctly.
- `complete`, `failed`, `stopped`, and `rejected` are terminal lifecycle outcomes. Once observed, report the outcome and schedule history/run id.
- Do not promise automatic watcher shutdown unless it is explicitly implemented and verified. If the scheduled worker has an authorized `schedule.pause` capability, it may pause the exact schedule on a terminal transition only when that behavior was agreed; otherwise tell the user how to pause it.
- Never call stop/interrupt/resume/retry on the watched run unless the user separately requests that action.

## What to report

On success, state the schedule id, run id being watched, interval, next run, project `cwd`, notification behavior, and Pi-open requirement. Give management calls such as `schedule.show`, `schedule.history`, `schedule.pause`, `schedule.resume`, and `schedule.delete`. If run status could not be read from the scheduled worker context, report that limitation rather than a fabricated monitor.
