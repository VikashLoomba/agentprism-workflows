/** Only workflow_monitor's final input can bind a view. Partial input and lifecycle inputs cannot. */
export function observedRunIdFromArgs(args: Record<string, unknown> | null): string | undefined {
  if (!args || Object.keys(args).some((key) => key !== "runId")) return undefined;
  const runId = args["runId"];
  return typeof runId === "string" && runId.trim().length > 0 && runId === runId.trim()
    ? runId
    : undefined;
}
