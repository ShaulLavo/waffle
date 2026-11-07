export type ReportStream = { messages: string[]; cutoff: number | null };
export function reportSequence(
  stream: ReportStream,
  sequence: number,
  encoded: string,
): "retry" | "next" {
  if (stream.cutoff !== null) throw new Error("Report after observation cutoff");
  if (stream.messages[sequence] === encoded) return "retry";
  if (!Number.isSafeInteger(sequence) || sequence !== stream.messages.length)
    throw new Error("Report sequence conflict or gap");
  return "next";
}
