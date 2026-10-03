# sandbox

OS-level sandboxing for bash commands: filesystem and network policy enforced by
the kernel for the command **and every child process** (`sandbox-exec` on macOS,
`bubblewrap` on Linux) via `@anthropic-ai/sandbox-runtime`.

This replaces the earlier policy-layer extension, which only gated the `write`/`edit`
tools and could be bypassed by any shell redirection. The per-call approval ability
now lives in the `policy` extension.

## Config — `~/.pi/agent/sandbox.json` (project override: `<cwd>/.pi/sandbox.json`)

```json
{
  "enabled": true,
  "unsandboxedCommands": ["screencapture"],
  "network": {
    "allowedDomains": ["open.bigmodel.cn", "github.com", "*.github.com", "registry.npmjs.org", "*.npmjs.org"],
    "deniedDomains": [],
    "allowLocalBinding": true,
    "allowMachLookup": ["com.apple.mDNSResponder", "com.apple.dnssd", "com.apple.system.opendirectoryd.libinfo"]
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "/tmp", "/private/tmp", "/private/var/folders", "~/.pi", "~/Library/Caches", "~/.npm"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

Legacy `{ "mode": "bypass" | "ask", "allowedPaths": [...] }` is migrated on load
(`bypass` → `enabled:false`, `ask` → `enabled:true`, paths appended to `allowWrite`);
the old file is kept as `sandbox.json.legacy.bak`.

## Measured behaviour (2026-10-03, async execution)

| Check | Result |
|---|---|
| write inside cwd / `/tmp` / `~/.pi` | allowed |
| read + write `~/.ssh` | denied (`Operation not permitted`) |
| allowlisted egress: `curl https://api.github.com`, `npm install`, `git ls-remote` | works |
| non-allowlisted egress: `curl https://example.com` | blocked (`CONNECT tunnel failed, response 403`) |
| provider host reachable | yes (`open.bigmodel.cn` → 401 without auth = reached) |
| esbuild / node / osascript / `pi` CLI inside the sandbox | work |
| `screencapture` inside the sandbox | fails — macOS does not grant screen-recording (TCC) to sandboxed processes; handled by `unsandboxedCommands` (below) |

**Important when writing your own tests:** run sandboxed commands **asynchronously**
(`spawn`). The proxy lives in the host process, so a synchronous harness (`spawnSync`)
blocks the event loop and makes every proxied request look like a timeout. That
artefact was the cause of an earlier, incorrect "network layer unusable" conclusion.

`/sandbox violations` lists denials (each blocked domain/path is recorded), and
`/sandbox allow-domain <d>` / `/sandbox allow-path <p>` widen the policy when a
legitimate command needs it.

## Escape hatch: `unsandboxedCommands`

Some commands cannot work inside a kernel sandbox at all. The known case is
`screencapture`: macOS never grants screen-recording (TCC/WindowServer) to a
seatbelt-sandboxed process, so the capture fails with "could not create image from
display" and no sandbox violation is even recorded (measured 2026-10-03 — adding
WindowServer/tccd mach lookups does not change it).

`unsandboxedCommands` lists command substrings that run **outside** the sandbox.
Matching is a plain substring test against the command text; every match is
reported to you once per session as a fact ("ran outside the sandbox"), so the
exception is never silent.

```json
{ "unsandboxedCommands": ["screencapture"] }
```

```
/sandbox allow-unsandboxed screencapture     # add
/sandbox deny-unsandboxed screencapture      # remove
```

Keep this list as short as possible: anything listed here bypasses both the
filesystem and the network policy. For a one-off need, `/sandbox off` for the
session is the alternative (it is a session switch, not a config edit).

Note: the computer-use extension takes screenshots in-process (nut.js / Swift AX),
so it is **not** affected by this — only bash-invoked `screencapture` is.

## Commands

```
/sandbox status
/sandbox on | off
/sandbox allow-domain registry.yarnpkg.com
/sandbox allow-path ~/work
/sandbox violations
```

Flag `--no-sandbox` disables it for one run.
