# Schedule recipes

Load this reference when creating or managing a `pi-subagents` schedule. The installed package's `subagent({action:"guide", topic:"missions"})` and `topic:"tool-reference"` are authoritative if its schema differs from these recipes.

## The required workflow shape

A schedule runs a JavaScript workflow, not a bare agent/task pair. A reusable template is bundled at [examples/periodic-check.js](../examples/periodic-check.js). Copy or adapt it to the target project's `.pi/workflows/` before scheduling; it checks `args.task` and returns a labeled `runs.run(...)` child.

Validate the exact script and its arguments before scheduling:

```ts
subagent({
  action: "validate",
  workflow: "./.pi/workflows/periodic-check.js",
  args: { task: "Check the requested condition and report the result." },
});
```

`validate` checks statically decidable syntax and structure without launching a child. It does not validate live target IDs, credentials, agent tool access, or future schedule execution.

## Create recipes

### One-shot

```ts
subagent({
  action: "schedule.create",
  id: "evening-review",
  name: "Evening review",
  at: "+30m",
  workflow: "./.pi/workflows/periodic-check.js",
  args: { task: "Review the current change and report findings." },
});
```

Use one `at` trigger for one-shot schedules. Do not also supply `every`.

### Fixed interval

```ts
subagent({
  action: "schedule.create",
  id: "periodic-check",
  name: "Periodic check",
  every: "5m",
  catchUp: "latest",
  workflow: "./.pi/workflows/periodic-check.js",
  args: { task: "Check the requested condition and report only material changes." },
  cwd: "/absolute/project/path",
});
```

Fixed intervals accept `m`, `h`, `d`, and `w`. `overlap` is fixed to `skip`. `catchUp` is `latest` by default, or `none`. Recurring `quiet: true` keeps successful automatic fires visible without waking the parent; use only when that notification behavior is wanted.

### Daily / weekly local time

```ts
subagent({
  action: "schedule.create",
  id: "daily-check",
  name: "Daily check",
  every: "day",
  at: "09:00",
  timezone: "America/Los_Angeles",
  workflow: "./.pi/workflows/periodic-check.js",
  args: { task: "Check the requested condition and report material changes." },
});
```

```ts
subagent({
  action: "schedule.create",
  id: "weekday-check",
  name: "Weekday check",
  every: "week",
  on: ["mon", "tue", "wed", "thu", "fri"],
  at: "09:00",
  timezone: "UTC",
  workflow: "./.pi/workflows/periodic-check.js",
  args: { task: "Check the requested condition and report material changes." },
});
```

Calendar triggers require `HH:mm` and an explicit IANA timezone or `UTC`. Weekly schedules require a non-empty `on` array; daily schedules do not accept `on`. Ask for timezone if it is not clear; don't silently use the machine timezone.

## Inline workflow

When the user needs a quick task without a reusable file, author one `js workflow` block and use `workflow: true`. Validate that block first, then pass the same `workflow: true` to `schedule.create`. The workflow is stored at creation time; later edits to a file do not update an existing schedule—recreate the schedule if the code changes.

For an inline workflow, copy the same body from [examples/periodic-check.js](../examples/periodic-check.js) into one `js workflow` block, then validate and create with `workflow: true`.

## Persistent state

Without `missionId`, each fire has fresh context and no `state` global. If deduplication or memory across fires is essential:

1. Create a mission explicitly using `subagent({action:"mission.create", ...})` if appropriate.
2. Attach its returned ID as `missionId` when creating the schedule.
3. Use workflow `state.get/set` for bounded state (for example, last observed status); keep fixed `args` separate and secret-free.

`schedule.create` accepts only an existing mission ID. Check current mission/schedule docs and same-project store behavior before attaching one.

## Inspect and manage

```ts
subagent({ action: "schedule.list" });
subagent({ action: "schedule.show", id: "periodic-check" });
subagent({ action: "schedule.history", id: "periodic-check" });
subagent({ action: "schedule.run", id: "periodic-check" });
subagent({ action: "schedule.pause", id: "periodic-check" });
subagent({ action: "schedule.resume", id: "periodic-check" });
subagent({ action: "schedule.delete", id: "periodic-check" });
```

Before creation, summarize the target, `cwd`, cadence/timezone, quiet/notification behavior, and expected permissions. Then validate and create. Report the returned id and next run; use list/show/history to verify instead of claiming an unconfirmed schedule exists.

## Runtime and storage caveats

- Schedules are project-scoped by default under `.pi/subagents/schedules/`; `scheduledRuns.storeRoot` can relocate storage.
- Timers live in the Pi process. Pi must be running for in-process timers to fire; saved schedules are restored when a session binds again. `schedule.run-due` is an external-launcher seam, not a daemon or an offline execution guarantee.
- `schedule.run-due` only processes due work for the current project/session context. Explain any external launcher setup separately.
- Schedule args are persisted for replay and must not contain secrets. Use supported plain JSON only.
