if (typeof args.runId !== "string" || !args.runId.trim()) {
  throw new Error("args.runId must be a non-empty pi-subagents async run id");
}
return runs.run("inspect-background-run", {
  agent: "worker",
  label: "Check background run status",
  task: [
    `Inspect pi-subagents async run ${args.runId} using only the subagent status action.`,
    "Report the exact lifecycle state and observed last-activity/attention facts returned by status.",
    "Do not infer a hang from silence; only compare to a user-provided idle threshold when timestamps are available.",
    "Do not stop, steer, resume, restart, edit files, or create another schedule.",
    "If persistent mission state is available, report whether the lifecycle state changed since the prior check.",
  ].join(" "),
});
