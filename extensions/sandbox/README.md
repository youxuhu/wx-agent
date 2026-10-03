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
  "enabled": false,
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

## Measured behaviour on this machine (2026-09-23)

| Check | Result |
|---|---|
| write inside cwd / `/tmp` / `~/.pi` | allowed |
| write + read `~/.ssh` | denied (`Operation not permitted`) |
| esbuild, node, osascript inside sandbox | work |
| `screencapture` inside sandbox | fails — macOS denies screen-recording TCC to sandboxed processes |
| `git ls-remote` (allowlisted) | works |
| `curl` / `npm` (allowlisted) | **hang** — the sandbox MITM proxy cannot reach upstream through the local transparent proxy |

Because of that last row the default is `enabled: false`: turning it on gives a
**sealed** shell (filesystem-protected; outbound HTTP from bash effectively blocked).
`parentProxy`, `mitmProxy:false` and `tlsTerminate:false` were all tried and did not
change it.

## Commands

```
/sandbox status
/sandbox on | off
/sandbox allow-domain registry.yarnpkg.com
/sandbox allow-path ~/work
/sandbox violations
```

Flag `--no-sandbox` disables it for one run.
