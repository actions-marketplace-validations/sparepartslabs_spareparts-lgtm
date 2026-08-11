import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "./validate-plugin.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "inherit" }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))); }); }
function options(args) { const result = { output: path.join(root, "release") }; for (let i = 0; i < args.length; i++) { if (args[i] === "--output" && args[i + 1]) result.output = path.resolve(args[++i]); else if (args[i] === "--version" && args[i + 1]) result.version = args[++i]; else throw new Error(`Unknown or incomplete argument: ${args[i]}`); } return result; }
export async function packagePlugin(args = process.argv.slice(2)) {
  const parsed = options(args); const validated = await validatePlugin(); const version = parsed.version ?? validated.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Release version must be x.y.z");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lgtm-marketplace-")); const folderName = `sparepartslabs-lgtm-marketplace-${version}`; const stage = path.join(temporary, folderName);
  try {
    await mkdir(path.join(stage, "plugins"), { recursive: true }); await cp(path.join(root, "marketplace.json"), path.join(stage, "marketplace.json")); await cp(path.join(root, "plugins", "lgtm"), path.join(stage, "plugins", "lgtm"), { recursive: true, dereference: false });
    const manifestPath = path.join(stage, "plugins", "lgtm", ".codex-plugin", "plugin.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.version = version; await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(parsed.output, { recursive: true }); const archive = path.join(parsed.output, `${folderName}.tar.gz`); await run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=go-w,u+rwX", "-czf", archive, "-C", temporary, folderName]);
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex"); const digestFile = `${archive}.sha256`; await writeFile(digestFile, `${digest}  ${path.basename(archive)}\n`); console.log(JSON.stringify({ archive, version, sha256: digest })); return { archive, digestFile, version, sha256: digest };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packagePlugin().catch((error) => { console.error(error.message); process.exitCode = 1; });
