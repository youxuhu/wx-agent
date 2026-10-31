# Intent, trajectory verification, and task-local memory

## 1. Create state-oriented intentions

Before the first GUI mutation, parse the request into:

- immutable user goal, exact values, constraints, and prohibited actions;
- ordered subgoals expressed as **observable outcomes**, not clicks/coordinates;
- each item's completion criterion and evidence source;
- dependencies and risk (especially final send/delete/purchase/submit).

Create todos using `todo({action:"create", subject, description, blockedBy?, metadata?})`. Tag each with `metadata.kind="computer-intent"` and a task-local `intentId`; put the success criterion in `description`. Create todos only for multi-step work or an explicit checklist. Keep only one todo `in_progress` at a time. Don't turn a single-step request into noisy bookkeeping.

Example:

```js
todo({action:"create", subject:"Open notification settings", description:"Outcome: the notification settings page is visible. Evidence: fresh screenshot or widget tree identifies that page.", metadata:{kind:"computer-intent", intentId:"gui-1", evidence:[], trajectoryEdges:[]}})
todo({action:"create", subject:"Turn notifications off", description:"Outcome: notification control is visibly off. Do not change other settings.", blockedBy:[1], metadata:{kind:"computer-intent", intentId:"gui-2", risk:"low", evidence:[], trajectoryEdges:[]}})
```

Use actual IDs returned by the tool; never assume the example IDs. Do not copy secrets or full personal form contents into metadata.

## 2. Observe → act → verify → reconcile

For each action, retain this order:

1. Read the active todo and its success criterion; note the current app/window/UI state.
2. Choose one necessary `computer` action. Preserve the existing permission gate. Permission to click is not permission to change the requested goal.
3. Read the tool result. If it is `minimal`, is only a `wait` receipt, or lacks a fresh post-action observation, call `computer({action:"screenshot"})` before making a semantic judgment. In particular, do not treat an unchanged hash from a stale/minimal observation as proof of no progress.
4. Do a distinct verification pass: compare the criterion with the **actual post-action observation**, not with the planned action. Record a short `evidence` fact and one verdict in metadata. The same main model performs a separate reasoning phase in v1; this is not an independent-model guarantee.
5. Only then update the todo and choose the next action.

Verdicts:

- `satisfied`: success criterion is visibly/effectively met, with evidence;
- `progress`: evidence shows movement toward the criterion, but it is not met yet;
- `neutral`: action executed, but no evidence of goal progress;
- `regression`: observation conflicts with the goal/constraints or moves away from them;
- `blocked`: permission/login/modal/user decision prevents safe progress;
- `uncertain`: current observations cannot support a judgment.

Action success, a hash change, navigation, or a model `goal_completed` claim alone must never produce `satisfied`. A screen can change for the wrong reason. Conversely, an action may advance a goal without a full-page change; identify a specific signal (selected state, playback status, confirmation, visible output) or leave it `uncertain`.

## 3. Update rules and learn from the episode

Keep task memory in the matching todo's metadata; maintain a small semantic state→action→state graph in `trajectoryEdges` (at most 8 unique edges per intent) and consult its most recent/relevant 5 edges as the working window. An edge records observed precondition, action, post-state, verdict, short evidence, and counts by verdict. Dedupe by semantic precondition + action, not screenshot hash alone:

```json
{
  "kind": "computer-intent",
  "intentId": "gui-2",
  "lastVerdict": "neutral",
  "blockedReason": null,
  "evidence": ["Settings window visible; switch still on (observation 4)."],
  "trajectoryEdges": [
    {"fromState": "notification settings; switch on", "action": "click row label", "toState": "same view; switch still on", "verdict": "neutral", "evidence": "fresh screenshot shows no toggle", "counts": {"satisfied": 0, "progress": 0, "neutral": 1, "regression": 0}}
  ]
}
```

Only describe facts that were actually observed. Count an edge as useful positive experience only when `progress` or `satisfied` has explicit evidence; execution success/page change alone never increments positive counts. Keep `neutral`, `regression`, `blocked`, and `uncertain` distinct. These edges are local to this task and their preconditions; do not generalize a failed click to other apps/screens. Before acting, retrieve the most relevant edges from the current todo and avoid repeating a neutral/regression edge from the same semantic state. Prefer a positive edge only when its starting state and intent match.

Status mapping:

| Verdict | Todo handling |
|---|---|
| `satisfied` + matching evidence | mark `completed`; attach concise evidence |
| `progress` | keep `in_progress`; update evidence and next condition |
| `neutral` | keep `in_progress`; log tried edge; pick a different route or re-observe |
| `regression` | keep the original goal; revise only unfinished route/steps and explain why |
| `blocked` | move unfinished item to `pending`, set `metadata.blockedReason`, ask the user if a decision/permission is needed |
| `uncertain` | do not complete; gather a better observation or ask rather than inventing success |

The todo extension has no native `blocked` or `replanned` status and does not allow `completed → in_progress`. Don't fake a status. If later evidence proves a completed *persistent-state* goal was reversed, mark the old task superseded in metadata, tombstone it only if appropriate, and create a linked repair todo. For event goals (e.g. a message was sent), a later screen change does not undo the historical event; keep its evidence.

## 4. When to revise intentions

The user goal is immutable; only the route and unfinished subgoals are adaptable.

- If the current UI already satisfies a criterion, verify and complete/skip that item without replaying the source-like route.
- If the UI differs but still offers a safe route to the same outcome, update only pending/in-progress todo descriptions/dependencies and note the observed reason.
- For a transient loading state, wait and observe again; don't replan from an intermediate frame.
- For a popup, login, OS permission, unexpected app, or external side effect, record the exact blocker and stop or ask. Never silently dismiss a dialog when doing so may confirm a consequential action.
- If the next step changes the user's goal, exact values, privacy, or authorized side effects, ask before revising it.
- Replan after a meaningful mismatch, verifier `regression/blocked`, or repeated `neutral`; don't run a planner after every click.

## 5. Safety and completion

Before sending, deleting, paying, purchasing, publishing, or submitting externally visible data, show the intended effect and ask for explicit user confirmation. `/cua bypass` changes the action permission gate only; it is not consent for a new task scope.

Finish only when every required outcome todo is completed with evidence, or clearly report which item is blocked/uncertain and what user decision is needed. Do not say the whole task succeeded merely because all planned clicks were issued.