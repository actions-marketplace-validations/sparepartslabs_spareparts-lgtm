import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resolver = resolve(repositoryRoot, "scripts/resolve-release-range.sh");
const workflow = resolve(repositoryRoot, ".github/workflows/release-plugin.yml");
const semanticWorkflow = resolve(repositoryRoot, ".github/workflows/semantic-release.yml");

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function commit(directory: string, message: string): string {
  writeFileSync(resolve(directory, "change.txt"), `${message}\n`, { flag: "a" });
  git(directory, "add", "change.txt");
  git(directory, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function fixture(): string {
  const directory = mkdtempSync(resolve(tmpdir(), "lgtm-release-range-"));
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.email", "tests@example.com");
  git(directory, "config", "user.name", "Release Tests");
  return directory;
}

function resolveRange(directory: string, tag: string): Record<string, string> {
  const output = resolve(directory, "output.txt");
  execFileSync(resolver, [tag, output], { cwd: directory });
  return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=", 2)));
}

test("resolves the previous stable tag and excludes aliases and prereleases", () => {
  const directory = fixture();
  commit(directory, "feat: first");
  git(directory, "tag", "v1.0.0");
  git(directory, "tag", "v1");
  commit(directory, "feat: preview");
  git(directory, "tag", "v1.1.0-beta.1");
  commit(directory, "feat: current");
  git(directory, "tag", "v1.1.0");

  assert.deepEqual(resolveRange(directory, "v1.1.0"), { from: "v1.0.0", to: "v1.1.0" });
});

test("falls back to the root commit for the first stable release", () => {
  const directory = fixture();
  const root = commit(directory, "feat: first");
  commit(directory, "fix: follow-up");
  git(directory, "tag", "v1.0.0");

  assert.deepEqual(resolveRange(directory, "v1.0.0"), { from: root, to: "v1.0.0" });
});

test("release workflow preserves artifacts and uses canonical notes safely", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /uses: sparepartslabs\/spareparts-changelog@v0/);
  assert.match(source, /provider: anthropic/);
  assert.match(source, /instructions: \$\{\{ vars\.CHANGELOG_INSTRUCTIONS \}\}/);
  assert.match(source, /anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.doesNotMatch(source, /openai-api-key|gemini-api-key/);
  assert.match(source, /write-repository: "false"/);
  assert.match(source, /id-token: write/);
  assert.match(source, /uses: aws-actions\/configure-aws-credentials@v5/);
  assert.match(source, /role-to-assume: \$\{\{ vars\.CHANGELOG_AWS_ROLE_ARN \}\}/);
  assert.match(source, /aws-region: \$\{\{ vars\.AWS_REGION \|\| 'us-east-1' \}\}/);
  assert.match(source, /publish-s3: "true"/);
  assert.match(source, /s3-bucket: \$\{\{ vars\.CHANGELOG_S3_BUCKET \}\}/);
  assert.match(source, /s3-key: releases\/lgtm\/\$\{\{ steps\.changelog-object\.outputs\.version \}\}\.md/);
  assert.match(source, /version=\$\{TAG#v\}/);
  assert.match(source, /publish-linkedin: "false"/);
  assert.match(source, /body_path: release\/release-notes\.md/);
  assert.match(source, /release\/\*\.tar\.gz/);
  assert.match(source, /release\/\*\.sha256/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /tag_name: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
});

test("successful main pushes create one semantic tag and dispatch packaging", () => {
  const source = readFileSync(semanticWorkflow, "utf8");
  assert.match(source, /workflow_run:/);
  assert.match(source, /workflows: \[Tests\]/);
  assert.match(source, /workflow_run\.conclusion == 'success'/);
  assert.match(source, /workflow_run\.event == 'push'/);
  assert.match(source, /workflow_run\.head_branch == 'main'/);
  assert.match(source, /cz bump --get-next/);
  assert.match(source, /git push origin "\$TAG"/);
  assert.match(source, /gh workflow run release-plugin\.yml --ref main -f tag="\$TAG"/);
});
