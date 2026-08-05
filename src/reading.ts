/**
 * Surfacing what a reviewer should read to understand the PR.
 *
 * This runs before the questions and is the friendly half of the tool: rather
 * than testing whether someone found the design doc, hand it to them. Sources,
 * in the order they are trusted:
 *
 *   1. Docs changed by the PR itself — the author already said these matter.
 *   2. Links in the PR description — issues, specs, RFCs, posts.
 *   3. Docs sitting next to the code the PR touched, unchanged by it. The most
 *      useful and the least certain, so they are ranked last and capped.
 *
 * Everything here is derived from the diff and the PR body. Nothing is fetched
 * or summarised: a summary is exactly the thing that lets someone approve
 * without reading (spec, Out of Scope).
 */

export interface ReadingItem {
  title: string;
  /** Repo-relative path or absolute URL. */
  href: string;
  /** Why it is on the list, shown to the reviewer. */
  why: string;
}

export interface ReadingInput {
  files: { filename: string; status: string }[];
  prBody: string | null;
  /** Paths that exist in the repo near the changed code. Optional. */
  neighbours?: string[];
  /** Owner/repo/ref, for turning paths into links. */
  repo: { owner: string; repo: string; ref: string };
}

const DOC_RE = /\.(md|mdx|rst|adoc)$/i;
const CHANGELOG_RE = /(^|\/)(changelog|release[-_]notes)/i;

/** Links in the PR body, excluding the noise a template leaves behind. */
export function linksIn(body: string | null): { href: string; title: string }[] {
  if (!body) return [];
  const out: { href: string; title: string }[] = [];
  const seen = new Set<string>();

  // Markdown links first, so we keep the author's own label for them.
  const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const m of body.matchAll(md)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ href: m[2], title: m[1] });
  }

  const bare = /(?<![(<\]])\bhttps?:\/\/[^\s<>)\]]+/g;
  for (const m of body.matchAll(bare)) {
    const href = m[0].replace(/[.,;:]$/, '');
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, title: href.replace(/^https?:\/\//, '') });
  }

  return out;
}

function isDoc(path: string): boolean {
  return DOC_RE.test(path) && !CHANGELOG_RE.test(path);
}

export const MAX_ITEMS = 5;

export function collect(input: ReadingInput): ReadingItem[] {
  const { owner, repo, ref } = input.repo;
  const blob = (p: string) =>
    `https://github.com/${owner}/${repo}/blob/${ref}/${p}`;

  const items: ReadingItem[] = [];
  const seen = new Set<string>();
  const push = (item: ReadingItem) => {
    if (seen.has(item.href)) return;
    seen.add(item.href);
    items.push(item);
  };

  for (const f of input.files) {
    if (!isDoc(f.filename)) continue;
    push({
      title: f.filename,
      href: blob(f.filename),
      why: f.status === 'added' ? 'added by this PR' : 'changed by this PR',
    });
  }

  for (const link of linksIn(input.prBody)) {
    push({ title: link.title, href: link.href, why: 'linked from the description' });
  }

  // Only docs that share a directory with changed code. A repo-wide doc sweep
  // would bury the two files that actually matter.
  const touchedDirs = new Set(
    input.files.map((f) => f.filename.split('/').slice(0, -1).join('/')),
  );
  for (const path of input.neighbours ?? []) {
    if (!isDoc(path)) continue;
    const dir = path.split('/').slice(0, -1).join('/');
    if (!touchedDirs.has(dir)) continue;
    push({ title: path, href: blob(path), why: 'sits with the code this PR touched' });
  }

  return items.slice(0, MAX_ITEMS);
}

export function renderReading(items: ReadingItem[]): string | null {
  if (items.length === 0) return null;
  const lines = ['**Worth reading first**', ''];
  for (const item of items) {
    lines.push(`- [${item.title}](${item.href}) <sub>— ${item.why}</sub>`);
  }
  return lines.join('\n');
}
