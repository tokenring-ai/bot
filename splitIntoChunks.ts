/**
 * Splits agent output into messages a platform will accept, preferring header
 * and paragraph boundaries so that a growing response re-chunks predictably as
 * more text streams in.
 */
export function splitIntoChunks(text: string, maxLength: number): string[] {
  const sections = text.split(/(?=\n#|\n\n)/);

  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    if (current.length + section.length > maxLength) {
      if (current) chunks.push(current);
      // Force-split oversized individual sections immediately
      let remaining = section;
      while (remaining.length > maxLength) {
        const breakPoint = remaining.lastIndexOf("\n", maxLength);
        const splitAt = breakPoint > maxLength * 0.5 ? breakPoint : maxLength;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt);
      }
      current = remaining;
    } else {
      current += section;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
