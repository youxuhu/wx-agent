# policy

Intent-layer permission rules with an audit trail: decides whether a tool call is
allowed, needs approval, or is denied — before it runs.

Division of labor with the `sandbox` extension: **policy decides intent**
(what the call is about), **the OS sandbox enforces effects** (what a process can
touch). Policy does not duplicate the sandbox's filesystem enforcement.

## Rules — `~/.pi/agent/policy.json`

Created with defaults on first run:

```json
[
  { "tool": "bash", "match": "/\\brm\\s+-[a-z]*[rf]/i", "action": "deny", "reason": "recursive/forced delete" },
  { "tool": "bash", "match": "/\\bsudo\\b/i", "action": "deny", "reason": "privilege escalation" },
  { "tool": "bash", "match": "/\\bcurl\\b[^|]*\\|\\s*(ba)?sh/i", "action": "deny", "reason": "piping a download into a shell" },
  { "tool": "bash", "match": "git push", "action": "ask", "reason": "publishes commits to a remote" },
  { "tool": "bash", "match": "npm publish", "action": "ask", "reason": "publishes a package" },
  { "tool": "bash", "match": "/\\bchmod\\b.*777/i", "action": "ask", "reason": "world-writable permissions" },
  { "tool": "write", "match": "outside-cwd", "action": "ask", "reason": "writes outside the session root" },
  { "tool": "edit", "match": "outside-cwd", "action": "ask", "reason": "writes outside the session root" }
]
```

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
/policy list
/policy test git push origin main      # shows the matching decision and rule
/policy audit 20
/policy add bash deny "docker system prune"   # add a rule
```

`outside-cwd` restores the approval behaviour of the earlier policy-layer sandbox
(writes outside the session root prompt before running).
