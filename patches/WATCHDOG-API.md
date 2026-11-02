# Upstream interface proposal (prepared locally; not submitted)

Expose a read-only process-local watchdog snapshot and change event through the package's public integration API. Consumers should not import generated chunks or wrap runtime methods.

Version 1 payload: sessionId, epoch, reviewId (when reviewing), selected provider/model, effective thinking, enabled, phase, last outcome, unresolved highest severity, and timestamp/sequence. Do not include prompts, chain of thought, credentials or raw tool output.

Semantics: emit on start/completion/failure/timeout/invalidation/disable/session replacement. Invalidated reviews cannot publish a successful result into a newer session/epoch. A snapshot query must return the latest state for an exact session, including when a UI attaches after the event. Missing telemetry is unknown, never clear. Consumers cannot approve actions or schedule reviews through this API.

Retire the local chunk patch only after the public seam passes current-model/low, session ownership, timeout, cancellation and late-result regression tests.
