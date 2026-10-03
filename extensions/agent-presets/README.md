# agent-presets

Let the main agent delegate a whole multi-role recipe in one call. A preset is a
plain JSON file naming an ordered list of agent steps; the `preset` tool runs it
foreground, serially, through the pi-subagents `subagent` tool, feeding each
step's output into the next.

## The tool

```ts
preset(
  preset: "coding" | "computeruse" | "research" | "review-loop" | "quick-fix" | <custom>,
  goal: "what the recipe should achieve",
  context?: "extra facts (paths, error text, constraints)",
  steps?: ["explore", "build"]   // optional subset, in preset order
)
```

Returns per-step facts plus the last step's full output:

```text
preset=coding  goal="fix the flaky test"  steps=3/3  status=ok  elapsed=214s
1. explore      scout        ok     38s   out=4123 chars
2. build        worker       ok     121s  out=9812 chars
3. review       reviewer     ok     55s   out=3204 chars

-- last step output --
<full reviewer output>
```

- Stops at the first failing step, marks it `failed`, and reports its error verbatim.
- Streams progress through the tool's update channel (`step 2/3 build (worker)…`).
- Honors the caller's abort signal; an abort skips the remaining steps.
- Each step is a real `subagent` call: normal validation, permissions, worktree
  isolation and usage accounting apply.

## Builtin presets

| Preset | Steps | Use for |
|---|---|---|
| `coding` | explore → build → review | a code change: recon, implement, independent review |
| `computeruse` | explore → computeruser → review | desktop GUI automation (the computeruser step carries the `computer-use` skill) |
| `research` | research → explore → advisor | investigate a topic or project: sources, local recon, risk opinion |
| `review-loop` | build → review → advisor | an existing change that needs more eyes |
| `quick-fix` | build | one small change, shortest path |

## Preset format

```jsonc
{
  "name": "coding",
  "description": "code change: recon, implement, independent review",
  "goal": "",                       // optional default; {{goal}} is replaced at run time
  "steps": [
    {
      "id": "explore",
      "role": "scout",              // agent name passed to the subagent tool
      "title": "explore",           // unique per preset; used by the `steps` selector
      "taskTemplate": "Recon …\nGoal: {{goal}}\n{{upstream}}",
      "worktree": false,            // optional: isolate this step in a git worktree
      "agentOverrides": {           // optional: passed straight to the subagent tool
        "model": "zai-api/glm-5.3-flash:low",
        "skill": ["computer-use"]
      }
    }
  ]
}
```

Placeholders: `{{goal}}`, `{{context}}`, `{{upstream}}`. An absent `{{upstream}}`
or `{{context}}` token means the value is appended as a labelled section instead
of being dropped; upstream is truncated at 8000 characters with a factual marker.

## Where presets come from

Resolution order (first hit wins when loading; listing is the union):

1. `$PI_PRESETS_DIR`
2. `~/.pi/agent/presets/*.json` — your overrides
3. `<extension dir>/templates/*.json` — builtin recipes
4. `~/.pi/agent/extensions/agent-presets/templates/*.json` — fallback path

To customize a builtin, copy it into `~/.pi/agent/presets/` and edit — your copy
wins by name. Unreadable preset files are reported in the tool description and
never silently ignored.

## Red lines

Code owns invariants (validation, unique titles, subset bounds, truncation,
stop-on-failure) and the execution plumbing. It makes no strategy decisions: the
main agent chooses the preset, writes the goal, and decides what to do with the
results. Progress and errors are reported as facts, with no suggested actions.
