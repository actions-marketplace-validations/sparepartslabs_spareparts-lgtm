import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplacePath = path.join(root, "marketplace.json");
const pluginRoot = path.join(root, "plugins", "lgtm");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function object(value, label) { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exactKeys(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unsupported field: ${key}`); }
function string(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`); if (/\[TODO:|<TODO>|PLACEHOLDER/i.test(value)) throw new Error(`${label} contains a placeholder`); return value; }
function safeRelative(value, label) { const entry = string(value, label); if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error(`${label} must be a safe relative path`); return entry; }
async function assertContainedFile(base, relative, label) { const candidate = path.resolve(base, relative); const actualBase = await realpath(base); const actual = await realpath(candidate); if (actual !== actualBase && !actual.startsWith(`${actualBase}${path.sep}`)) throw new Error(`${label} escapes its root`); if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`${label} must not be a symlink`); }

export async function validatePlugin() {
  const marketplace = object(JSON.parse(await readFile(marketplacePath, "utf8")), "marketplace");
  exactKeys(marketplace, ["name", "interface", "plugins"], "marketplace");
  if (marketplace.name !== "sparepartslabs") throw new Error("marketplace.name must be sparepartslabs");
  if (object(marketplace.interface, "marketplace.interface").displayName !== "Spare Parts Labs") throw new Error("marketplace displayName is invalid");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) throw new Error("marketplace must contain exactly one plugin");
  const entry = object(marketplace.plugins[0], "plugin entry"); exactKeys(entry, ["name", "source", "policy", "category"], "plugin entry");
  if (entry.name !== "lgtm" || entry.category !== "Developer Tools") throw new Error("LGTM marketplace identity is invalid");
  const source = object(entry.source, "plugin source"); exactKeys(source, ["source", "path"], "plugin source");
  if (source.source !== "local" || source.path !== "./plugins/lgtm") throw new Error("plugin source must be ./plugins/lgtm"); safeRelative(source.path, "plugin source path");
  const policy = object(entry.policy, "plugin policy"); exactKeys(policy, ["installation", "authentication"], "plugin policy");
  if (policy.installation !== "AVAILABLE" || policy.authentication !== "ON_INSTALL") throw new Error("plugin policy is invalid");
  const manifest = object(JSON.parse(await readFile(manifestPath, "utf8")), "plugin manifest"); exactKeys(manifest, ["name", "version", "description", "author", "skills", "interface"], "plugin manifest");
  if (manifest.name !== "lgtm") throw new Error("plugin manifest name must be lgtm"); if (!semver.test(string(manifest.version, "plugin version"))) throw new Error("plugin version must be semantic version");
  string(manifest.description, "plugin description"); string(object(manifest.author, "plugin author").name, "plugin author name");
  if (safeRelative(manifest.skills, "skills path") !== "./skills/") throw new Error("skills path must be ./skills/");
  const ui = object(manifest.interface, "plugin interface"); string(ui.displayName, "plugin displayName"); string(ui.shortDescription, "plugin shortDescription");
  await assertContainedFile(pluginRoot, ".codex-plugin/plugin.json", "plugin manifest"); await assertContainedFile(pluginRoot, "commands/lgtm.md", "canonical LGTM command"); await assertContainedFile(pluginRoot, "skills/lgtm/SKILL.md", "LGTM skill");
  const command = await readFile(path.join(pluginRoot, "commands/lgtm.md"), "utf8"); const skill = await readFile(path.join(pluginRoot, "skills/lgtm/SKILL.md"), "utf8");
  if (/\[TODO:|<TODO>|PLACEHOLDER/i.test(command) || /\[TODO:|<TODO>|PLACEHOLDER/i.test(skill)) throw new Error("LGTM instructions contain a placeholder");
  const commandBody = command.replace(/^---\n[\s\S]*?\n---\n\n/, ""); const skillBody = skill.replace(/^---\n[\s\S]*?\n---\n\n/, "");
  if (!skillBody.startsWith(commandBody)) throw new Error("Codex skill canonical body has drifted from commands/lgtm.md");
  if (command.includes("/memories") || /\bCodex\b/.test(commandBody)) throw new Error("canonical command must remain agent-neutral");
  return { name: manifest.name, version: manifest.version };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validatePlugin().then(({ name, version }) => console.log(`Validated ${name}@${version}`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
