/** Markdown and plain-text version headings share the same history format. */
export function splitUpdateNotes(notes: string): string[] {
  const text = notes.trim()
  if (!text) return []
  const starts = [...text.matchAll(/^(?:#{1,6}\s*)?v\d+\.\d+\.\d+[^\n]*更新说明[^\n]*$/gm)].map(match => match.index ?? 0)
  if (!starts.length) return [text]
  starts[0] = 0
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length).trim()).filter(Boolean)
}
