/**
 * Just enough unified-diff parsing to hold the generator honest.
 *
 * FR-012 says every question must cite the file and hunk it was drawn from, and
 * a question that cannot be grounded must be dropped. A prompt asking the model
 * to cite its source gets citations; it does not get *correct* citations. So
 * the citation is checked here, against the actual diff: a question naming a
 * file the PR didn't touch, or a hunk header that doesn't appear in that file,
 * is dropped before it can reach a reviewer.
 *
 * This is the difference between the model promising it read the diff and the
 * code confirming it.
 */

export interface Hunk {
  /** The `@@ -a,b +c,d @@` line, verbatim. Used as the citation key. */
  header: string;
  /** Body lines, including the leading ` `, `+`, or `-`. */
  lines: string[];
}

export interface FileDiff {
  /** Post-image path (the `+++ b/...` side), or the pre-image if deleted. */
  path: string;
  hunks: Hunk[];
}

const FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;

  for (const line of diff.split('\n')) {
    const fileMatch = FILE_RE.exec(line);
    if (fileMatch) {
      file = { path: fileMatch[2], hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (HUNK_RE.test(line)) {
      hunk = { header: line.trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    // `--- a/x` and `+++ b/x` precede the first hunk; skip them so they aren't
    // mistaken for content. Once a hunk is open, every line belongs to it.
    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    hunk.lines.push(line);
  }

  return files;
}

/** Added and removed lines only — what the PR actually changed. */
export function changedLines(file: FileDiff): number {
  return file.hunks.reduce(
    (n, h) =>
      n + h.lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length,
    0,
  );
}

/**
 * Does this (file, hunk) citation name something that exists?
 *
 * The hunk match is a prefix comparison on the `@@ ... @@` portion: models
 * reproduce the ranges reliably but often drop or reword the trailing section
 * heading GitHub appends, and failing a correct question over that would be
 * pedantry. The ranges are what identify the hunk.
 */
export function isGrounded(files: FileDiff[], path: string, header: string): boolean {
  const file = files.find((f) => f.path === path);
  if (!file) return false;
  const key = hunkKey(header);
  if (!key) return false;
  return file.hunks.some((h) => hunkKey(h.header) === key);
}

function hunkKey(header: string): string | null {
  const m = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(header.trim());
  return m ? m[0] : null;
}

/**
 * The diff, trimmed to what is worth asking about, with each hunk labelled so
 * the model has a citation key to return.
 *
 * Files are dropped rather than truncated — a half-included file produces
 * questions about code the reviewer can't see in the citation.
 */
export function renderForPrompt(
  files: FileDiff[],
  budget: number,
): { text: string; included: FileDiff[] } {
  const out: string[] = [];
  const included: FileDiff[] = [];
  let used = 0;

  // Most-changed first: if the budget runs out, it runs out on the files least
  // likely to carry the point of the PR.
  for (const file of [...files].sort((a, b) => changedLines(b) - changedLines(a))) {
    const block = [
      `### ${file.path}`,
      ...file.hunks.map((h) => [h.header, ...h.lines].join('\n')),
    ].join('\n');
    if (used + block.length > budget) continue;
    out.push(block);
    included.push(file);
    used += block.length;
  }

  return { text: out.join('\n\n'), included };
}
