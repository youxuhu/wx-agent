---
name: pi-scheduled-automation
description: Create and validate Pi scheduled workflows. Use for English or Chinese requests about schedules/automation, 定时任务、周期执行、每隔 N 分钟、每日/每周、定时检测 or 监视后台任务; also manage or monitor pi-subagents runs. Uses pi-subagents schedules, not ordinary delegation or arbitrary OS/CI monitoring.
---

# Pi scheduled automation

Use the installed `pi-subagents` scheduler; do not invent a timer API. Load only the matching reference below, then act on the user's request.

## Required workflow

1. Identify the target, project `cwd`, trigger, and desired result/notification behavior. For monitoring, v1 means a known `pi-subagents` async `runId`; do not imply that arbitrary PIDs, shell jobs, CI, or OS services are supported.
2. Ask only for missing information that changes execution. For calendar schedules require an explicit IANA timezone (or `UTC`). If the user asks for a recurring check but gives no interval, ask or offer a concrete suggestion; never silently create a guessed schedule.
3. `schedule.create` requires exactly one trigger (`at` or `every`) and a JS workflow (`workflow: true` or a script path). A plain `{agent, task}` is not a schedule target.
4. Read `references/schedule-recipes.md` for ordinary schedules, or `references/watch-background-run.md` for monitoring. Before relying on exact fields, use `subagent({action: "guide", topic: "missions"})` and `subagent({action: "guide", topic: "tool-reference"})` if the installed schema is unclear.
5. Validate the workflow with `subagent({action: "validate", workflow: ...})` before creating it. Validation checks static workflow syntax/structure; it does not prove that a target run exists, a child agent has the needed tools, or the schedule will run while Pi is closed.
6. After creation, report the schedule id, trigger/next run, `cwd`, how to inspect history/pause/resume/delete, and the Pi process lifecycle limitation. Do not claim success until `schedule.create` returns successfully.

## Safety and semantics

- Scheduled fires use fresh context. Attach an **existing** `missionId` only when cross-fire state is needed; without it there is no workflow `state` global. Never put secrets in `args`.
- Runs are asynchronous. Overlap is `skip`; `catchUp` is `latest` by default or `none`.
- Pi's scheduler is not a daemon: its in-process timers need Pi running. `schedule.run-due` is an external-launcher seam, not a promise of execution while Pi is closed.
- `quiet: true` on recurring schedules suppresses parent wakeups for successful automatic runs; failures/stops/pauses still wake. Do not set it on a monitor by default if the user expects prompt completion alerts. Explain the notification-vs-noise tradeoff.
- Monitoring is read-only unless the user separately authorizes intervention. Never kill/restart a target, edit code, or infer “stuck” from silence alone.

## References

- Ordinary/one-shot/recurring/calendar recipes, validation, management, catch-up and mission state: [references/schedule-recipes.md](references/schedule-recipes.md).
- Monitoring a Pi async run, statuses, attention events, and limits: [references/watch-background-run.md](references/watch-background-run.md).
