export function parseSseChunk(buffer: string, chunk: string) {
  const updated = buffer + chunk;
  const lines = updated.split("\n");
  const remaining = lines.pop() ?? "";
  const events: Array<{ type: string; data: unknown }> = [];

  let currentEvent = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      try { events.push({ type: currentEvent, data: JSON.parse(line.slice(6)) }); } catch { /* skip */ }
      currentEvent = "";
    } else if (line === "") {
      currentEvent = "";
    }
  }
  return { buffer: remaining, events };
}
