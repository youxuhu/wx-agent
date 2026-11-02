# Lightweight deployment — 2026-11-02

Implemented the plan in PLAN-plugin-maintenance.md. No commits, pushes or model requests were made.

## Active runtime

pi-lens is removed from settings.packages. Its installed files and former dependencies remain cached for rollback, and its Skill manifest is not loaded. No lens automatic diagnostics/formatting/autofix runs in the new process.

Retained packages are pinned: pi-web-access 0.46.0, rpiv-todo/rpiv-ask-user-question 2.15.0, pi-subagents 0.84.0, pi-btw 0.63.3. Added @narumitw/pi-lsp 0.49.11: two on-demand tools, no edit/turn diagnostic hook. Its language servers start per call and shut down afterward. Existing TypeScript/Pyright tools under ~/.pi-lens/tools are reused, not downloaded again. Existing binary paths are preserved locally; the shared template now uses language-server commands from PATH.

LSP diagnostic calls require explicit paths and limit 1..5. Fixes default to preview. Plan mode blocks lsp_fix. Project-native validation remains authoritative. Watchdog still follows the current model with low thinking, but its automatic LSP pre-pass is disabled. The seven 1M-window compaction overrides and default DeepSeek model remain unchanged.

## Context and output

Removed the duplicate tool-awareness list. Plan/Build and GUI rules are concise; detailed GUI instructions remain in the existing Skill. RPIV guidance uses its native configuration at ~/.config/rpiv-*/config.json (XDG_CONFIG_HOME is honored). tool_search is enabled and codemode inline budget is 1000.

Comparable isolated RPC lifecycle measurements, with no project context or model call:

| Metric | Before | After |
|---|---:|---:|
| System prompt characters | 17,059 | 8,127 |
| Active tools | 26 | 21 |
| Skills | 9 | 5 |
| Active tool schema characters | 20,330 | 14,711 |

System prompt decreased 52.4%. The schema figure is a registry measurement, not exact provider tokens. Actual model latency/accuracy is not established by this measurement. The TUI question tool remains available; RPC mode hides it when no interactive UI is present.

Long text from bash/read/read_xlsx (>8000 characters, no image blocks) is stored privately. The visible result keeps its head, error tail and output reference. Bash structured results retain the actual exit code and point to the saved full output. Original upstream truncation cannot be reversed if the source was already incomplete.

- `/outputs`: recent full output IDs for this session.
- `output_read`: deferred/codemode tool for bounded line ranges or literal substring lookup, capped at 6000 preview characters.
- `/handoff [note]`: save a bounded, non-model-generated handoff with user corrections, latest todo state, recent assistant reports, prior compaction, evidence and output references. Does not modify AGENTS.md or switch sessions. Reports remain claims, not independently verified truth. Long historical scope may be shortened: inspect the source session when the handoff marks insufficient state.
- `/verification recipes`: show candidate project validation commands; does not execute them.
- `/updates`: read the cached candidate report. `/updates check` explicitly fetches npm metadata; never installs candidates.
- `/health`: active versions, bridge readiness, source/patch/config drift and SDK version checks.

## Source of truth and maintenance

This is the managed source package (package.json version 0.2.0). Its extensions are synced into ~/.pi/agent/extensions; do not also pi-install this source directory and double-load them. Dependencies are provided by Pi or the existing per-extension dependency directories; runtime state is excluded from source synchronization.

maintenance-lock.json records exact active npm versions/integrity, Pi/Node/SDK peer versions, installed source hashes, external guidance hashes and patched file hash. It contains no auth material. The registry integrity describes the original package archive; patched file hashes describe our local change separately.

```
python3 scripts/maintain.py verify
python3 scripts/maintain.py install
python3 scripts/maintain.py update-check
python3 scripts/maintain.py rollback --backup /absolute/path/to/rollback.json
python3 scripts/test.py
```

Install is idempotent and transactional, preserves unrelated settings, preflights the hash-guarded patch, and keeps exact rollback copies. Rollback refuses to overwrite later edits. Changing package/core/peer versions or modifying the watchdog chunk requires a fresh compatibility check. Unknown patch contents fail before runtime mutation. No automatic update daemon was added.

For this deployment, `backups/rollback-full-lightweight.json` restores the pre-lightweight runtime/configuration in one guarded rollback. Extra cached npm files are retained. The old scripts/install.py entry now delegates to the transactional installer. Run maintenance from this source directory; dependencies must already be installed at their pinned versions.

The watchdog bridge is still a minimal version-specific patch, not an upstream public API. An interface proposal is prepared in patches/WATCHDOG-API.md; it has not been sent externally. Candidate update results are metadata only, explicitly untested. Isolated rehearsal proved that unverified chunk changes are rejected and rollback restores the original configuration.

## Validation

Passed: existing undo/redo/native Pi SessionManager, footer widths/caching, watchdog late-result handling, PDF cache, validation evidence, pre-push scanning, new output retrieval/handoff/path bounds, Plan/LSP mutation gating, install/idempotence/drift/rollback tests, and actual TypeScript error diagnostics using the installed LSP.

Full SDK lifecycle load after replacement: no loader/lifecycle errors; no lens tools or Skills. LSP integration required local process IPC beyond the sandbox and was tested only in a temporary project. It made no model requests and changed no user project.

Run `/reload` in Pi, then `/health`. Existing in-flight runs retain their loaded code until reload. If a project explicitly loads pi-lens through its own configuration, remove that override separately; global settings do not silently override an explicit project package.

For cross-machine setup and known absolute-path limitations, see [MULTI-MACHINE.md](MULTI-MACHINE.md) and [MAINTENANCE.md](MAINTENANCE.md). Historical backup paths in this report apply only to the original machine.

Reliability fixes: portable SDK/test resolution, preflight and deployment locks, preserved local LSP overrides, backup publication guards, streaming output lookup with storage budget, and explicit handoff truncation/source references. See MAINTENANCE.md for the current behavior.
