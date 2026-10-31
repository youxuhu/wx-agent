if (typeof args.task !== "string" || !args.task.trim()) {
  throw new Error("args.task must be a non-empty string");
}
return runs.run("periodic-check", {
  agent: "worker",
  task: args.task,
  label: "Run scheduled check",
});
