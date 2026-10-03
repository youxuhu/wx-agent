# policy

Intent-layer permission rules with an audit trail: decides whether a tool call is
allowed, needs approval, or is denied — before it runs.

Division of labor with the `sandbox` extension: **policy decides intent**
(what the call is about), **the OS sandbox enforces effects** (what a process can
touch). Policy does not duplicate the sandbox's filesystem enforcement.

## Modes — how much approval you want

`/policy mode auto|normal|strict` (persisted; the approval prompt can also switch to `auto`
for the current session without leaving the flow):

| Mode | Behaviour |
|---|---|
| `auto` | ask-rules are **auto-allowed** (still audited). Deny rules always hold. Fewest prompts. |
| `normal` | ask-rules prompt. Default. |
| `strict` | like normal, **plus** calls no rule matches also prompt (default-allow → ask). |

The prompt shows the target, the matching rule and its reason, and offers four choices:
`Allow once` / `Always allow: <the exact command>` / `Switch to auto mode (fewer prompts, this session)` / `Deny`.

## Rules — `~/.pi/agent/policy.json`

```json
{
  "mode": "normal",
  "rules": [
  { "tool": "bash", "match": "/\\brm\\s+-[a-z]*[rf]/i", "action": "deny", "reason": "recursive/forced delete" },
  { "tool": "bash", "match": "/\\bsudo\\b/i", "action": "deny", "reason": "privilege escalation" },
  { "tool": "bash", "match": "/\\bcurl\\b[^|]*\\|\\s*(ba)?sh/i", "action": "deny", "reason": "piping a download into a shell" },
      { "tool": "bash", "match": "/^\\s*git\\s+push\\b/i", "action": "ask", "reason": "publishes commits to a remote" },
      { "tool": "bash", "match": "/^\\s*npm\\s+publish\\b/i", "action": "ask", "reason": "publishes a package" },
  { "tool": "bash", "match": "/\\bchmod\\b.*777/i", "action": "ask", "reason": "world-writable permissions" },
    { "tool": "write", "match": "outside-cwd", "action": "ask", "reason": "writes outside the session root" },
    { "tool": "edit", "match": "outside-cwd", "action": "ask", "reason": "writes outside the session root" }
  ]
}
```

`deny`/`ask` patterns are **anchored at a command boundary** (`^`, or after `;` `&` `|`) so the
text `rm -rf` inside a heredoc, comment or string literal does not false-positive, while a real
command on its own line still matches. A bare-array config and the earlier unanchored defaults
migrate automatically on load.

- `tool`: tool name or `*`.
- `match`: substring, `/regex/`, or the special `outside-cwd` (paths only).
  Matched against: bash → the command; write/edit → the resolved path; other tools → JSON of params.
- `action`: `allow` | `ask` | `deny`; `reason` is shown in the prompt and logged.
- Decision order: **deny > ask > allow > default allow**. First match wins per tier.

## Audit — `~/.pi/agent/policy-audit.log`

One line per decision:

```
2026-10-03T14:14:27.859Z | bash | rm -rf / | denied | deny:/\brm\s+-[a-z]*[rf]/i | rule
```

## Commands

```
/policy mode auto|normal|strict
/policy list
/policy test git push origin main      # shows the matching decision and rule
/policy audit 20
/policy add bash deny "docker system prune"   # add a rule
```

`outside-cwd` restores the approval behaviour of the earlier policy-layer sandbox
(writes outside the session root prompt before running).
