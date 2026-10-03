# agent-orchestra

In-terminal subagent lane orchestrator for pi. `/orchestra` opens a fullscreen
lane UI; arrow keys arrange preset-role agents into a pipeline; the chain runs
through the pi-subagents RPC bus with upstream output injected into each
downstream task.

## Usage

```
/orchestra              # open the lane (empty or last used)
/orchestra <name>       # open a saved pipeline (global or project scope)
/orchestra-dry [name]   # dry run: print the exact spawn plan (facts only)
```

## Lane keys

| Key | Edit mode | Monitor mode |
|---|---|---|
| ↑ / ↓ | select step | select step |
| ← / → | reorder step | — |
| a | add step (role palette) | — |
| e | edit title + task template | — |
| g | edit pipeline goal | — |
| d | delete step | — |
| w | toggle worktree isolation | — |
| space | run single step | — |
| ⏎ | run whole chain | close |
| s | — | steer running step |
| x | — | stop step |
| ^S | save pipeline (global) | save |
| esc / q | close | close |

## Roles

Preset lanes (english names, mapped to pi-subagents agents):

| lane | agent | notes |
|---|---|---|
| explore | scout | read-only recon, fresh context |
| build | worker | implementation + validation |
| computeruser | worker | GUI automation via computer-use skill |
| review | reviewer | independent review gate, fresh context |
| advisor | oracle | second opinion |
| research | researcher | web/docs research |

Custom agents in `~/.pi/agent/agents/*.md` are enumerated automatically.
Aliases: `~/.pi/agent/orchestrations/roles.json` → `{"alias": "agentName"}`.

## Linking steps

`{{upstream}}` in a task template is replaced with the previous step's output
(truncated at 8000 chars with a factual marker). Without the placeholder, the
upstream output is appended as a section. Parallel steps (`parallel: true`)
run together with the previous step; their outputs are concatenated before
being carried downstream.

## Templates

Builtin templates ship with the extension (`templates/*.json`, read-only baseline).
They go through the same validation as user pipelines and can be saved as an
editable copy with `^S`.

| Template | Steps | Use for |
|---|---|---|
| `coding` | explore → build → review | normal code change: recon, implement, independent review |
| `computeruse` | explore → computeruser → review | desktop GUI automation (computeruse preset carries the computer-use skill) |
| `research` | research ∥ explore → advisor | project investigation: external sources + local recon + risk opinion |
| `review-loop` | build → review → advisor | an existing change that needs more eyes |
| `quick-fix` | build | one small change, shortest path |

`/orchestra` with no argument lists saved pipelines **and** templates
(`name (template)`); `/orchestra <name>` resolves project → global → template.

Resolution order for templates: `PI_ORCHESTRA_TEMPLATES` env → directory next to
the extension source → `~/.pi/agent/extensions/agent-orchestra/templates`.

Tasks use two placeholders: `{{goal}}` (pipeline goal, prompted once before the
run when missing) and `{{upstream}}` (previous step output).

## Persistence

- global: `~/.pi/agent/orchestrations/<name>.json`
- project: `<git-root>/.pi/orchestrations/<name>.json` (loaded preferentially)

## Execution

Spawning goes over the public pi-subagents in-process RPC
(`subagents:rpc:v1:*`, async spawn). Failure stops the chain with the error
verbatim on the card; completed steps are kept, so `space` resumes from a
breakpoint. Steering uses `runs.steer` semantics; stopping records a stopped
lifecycle. Worktree steps are never auto-merged — the UI only reports facts.

## Red lines

Data + UI only: no fixed strategy, prompts are pure facts, role list is
enumerated at runtime, non-TUI mode degrades to printing pipeline JSON.
