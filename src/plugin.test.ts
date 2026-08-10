import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execute, readJson, readText, temporaryDirectory } from "./plugin-test-helpers.ts";

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject => { assert(value && typeof value === "object" && !Array.isArray(value)); return value as JsonObject; };

test("manifest and marketplace expose the canonical install identity", async () => {
  const manifest = asObject(await readJson("plugins/lgtm/.codex-plugin/plugin.json"));
  assert.equal(manifest.name, "lgtm"); assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/); assert.equal(manifest.skills, "./skills/");
  const marketplace = asObject(await readJson("marketplace.json")); assert.equal(marketplace.name, "sparepartslabs");
  const plugins = marketplace.plugins as unknown[]; assert.equal(plugins.length, 1); const entry = asObject(plugins[0]);
  assert.deepEqual(entry.source, { source: "local", path: "./plugins/lgtm" });
  assert.deepEqual(entry.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" }); assert.equal(entry.category, "Developer Tools");
});

test("skill has valid frontmatter, triggers, delegation, prerequisites, and neutral failures", async () => {
  const skill = await readText("plugins/lgtm/skills/lgtm/SKILL.md");
  assert.match(skill, /^---\nname: lgtm\ndescription: .+\n---/); assert.match(skill, /run LGTM/i); assert.match(skill, /unpublished changes/i);
  assert.match(skill, /git rev-parse --show-toplevel/); assert.match(skill, /command -v sp/); assert.match(skill, /`sp lgtm`/);
  assert.match(skill, /no reviewable diff/i); assert.match(skill, /provider support or credentials/i); assert.match(skill, /internal error/i); assert.match(skill, /neutrally/i);
  assert.match(skill, /Do not install a Git hook, run `sp lgtm install`/);
});

test("consent is exactly one explicit yes/no question with canonical opt-in text", async () => {
  const skill = await readText("plugins/lgtm/skills/lgtm/SKILL.md");
  const question = "Would you like me to remember to run LGTM before I push changes or create a pull request?";
  assert.equal(skill.split(question).length - 1, 1);
  assert.match(skill, /If the user says no, continue the current LGTM run without stating an affirmative preference candidate/);
  assert.match(skill, /If the user says yes, state this exact standalone sentence/);
  assert.equal(skill.split("Before I perform a git push or create a pull request, run LGTM against the changes being published.").length - 1, 1);
  assert.match(skill, /interaction is unavailable[\s\S]+do not ask/); assert.match(skill, /memory is disabled[\s\S]+do not ask/);
});

test("memory guidance is honest, supported, and cannot mutate implicit state", async () => {
  const skill = await readText("plugins/lgtm/skills/lgtm/SKILL.md");
  assert.match(skill, /extracts memories asynchronously/); assert.match(skill, /memory candidate rather than a claim of immediate persistence/); assert.match(skill, /\/memories/);
  assert.match(skill, /Never silently edit instruction files or generated memory files/); assert.match(skill, /host verifies it/);
  assert.doesNotMatch(skill, /~\/(?:\.codex|\.agents)\/.*memor/i); assert.doesNotMatch(skill, /immediately (?:saved|persisted|remembered)/i);
});

test("repeat-use and recursive publish behavior respect injected preferences", async () => {
  const skill = await readText("plugins/lgtm/skills/lgtm/SKILL.md");
  assert.match(skill, /affirmatively says[\s\S]+do not ask again/); assert.match(skill, /user declined[\s\S]+do not ask again/);
  assert.match(skill, /pre-publish action[\s\S]+never invoke itself recursively/); assert.match(skill, /only to publishing actions performed by the active agent/);
  for (const operation of ["inspect", "enable", "remove", "change"]) assert.match(skill, new RegExp(operation, "i"));
});

test("canonical command is agent-neutral and embedded verbatim by the Codex adapter", async () => {
  const command = await readText("plugins/lgtm/commands/lgtm.md"); const skill = await readText("plugins/lgtm/skills/lgtm/SKILL.md");
  const body = command.replace(/^---\n[\s\S]*?\n---\n\n/, ""); const skillBody = skill.replace(/^---\n[\s\S]*?\n---\n\n/, "");
  assert(skillBody.startsWith(body)); assert.doesNotMatch(body, /\bCodex\b|\/memories/); assert.match(body, /active agent/);
  assert.match(body, /host has no supported memory or instruction mechanism/); assert.match(body, /Only after explicit consent/); assert.match(body, /Never silently edit instruction files/);
  assert.match(skillBody.slice(body.length), /For Codex[\s\S]+\/memories/);
});

test("repository validator accepts the complete package", async () => {
  const result = await execute(process.execPath, ["scripts/validate-plugin.mjs"]); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Validated lgtm@\d+\.\d+\.\d+/);
});

test("packager produces deterministic, minimal, version-injected archives", async () => temporaryDirectory(async (directory) => {
  const first = path.join(directory, "first"); const second = path.join(directory, "second");
  for (const output of [first, second]) { const result = await execute(process.execPath, ["scripts/package-plugin.mjs", "--output", output, "--version", "2.3.4"]); assert.equal(result.code, 0, result.stderr); }
  const filename = "sparepartslabs-lgtm-marketplace-2.3.4.tar.gz"; const a = await readFile(path.join(first, filename)); const b = await readFile(path.join(second, filename));
  assert.equal(createHash("sha256").update(a).digest("hex"), createHash("sha256").update(b).digest("hex"));
  const listing = await execute("tar", ["-tzf", path.join(first, filename)]); assert.equal(listing.code, 0, listing.stderr);
  const members = listing.stdout.trim().split("\n"); assert(members.every((member) => member.startsWith("sparepartslabs-lgtm-marketplace-2.3.4/"))); assert(members.every((member) => !member.includes("../")));
  assert(members.some((member) => member.endsWith("marketplace.json"))); assert(members.some((member) => member.endsWith(".codex-plugin/plugin.json"))); assert(members.some((member) => member.endsWith("skills/lgtm/SKILL.md"))); assert(members.some((member) => member.endsWith("commands/lgtm.md")));
  assert(members.every((member) => !/(?:node_modules|src\/|memory|\.env)/.test(member)));
  const manifest = await execute("tar", ["-xOzf", path.join(first, filename), "sparepartslabs-lgtm-marketplace-2.3.4/plugins/lgtm/.codex-plugin/plugin.json"]); assert.equal(manifest.code, 0); assert.equal(JSON.parse(manifest.stdout).version, "2.3.4");
}));
