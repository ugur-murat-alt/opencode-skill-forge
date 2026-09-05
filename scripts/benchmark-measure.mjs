/** Record every attempted call, including transport, tool and payload failures. */
export async function measureCall(
  sender,
  tool,
  args,
  phase,
  record,
  scheduledAt,
) {
  const start = performance.now();
  let responseBytes = 0;
  let outcome = "error";
  try {
    const response = await sender.callTool({ name: tool, arguments: args });
    responseBytes = Buffer.byteLength(JSON.stringify(response));
    if (response.isError) throw Error(JSON.stringify(response));
    const value = JSON.parse(
      response.content.find((c) => c.type === "text").text,
    );
    outcome = "success";
    return value;
  } finally {
    const end = performance.now();
    record({
      tool,
      phase,
      outcome,
      elapsed_ms: end - start,
      scheduler_delay_ms:
        scheduledAt === undefined ? 0 : Math.max(0, start - scheduledAt),
      scheduled_to_complete_ms:
        scheduledAt === undefined
          ? end - start
          : Math.max(0, end - scheduledAt),
      response_bytes: responseBytes,
    });
  }
}
