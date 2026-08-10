import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
export const repoRoot = path.resolve(import.meta.dirname, "..");
export async function readJson(relative: string): Promise<unknown> { return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8")); }
export async function readText(relative: string): Promise<string> { return readFile(path.join(repoRoot, relative), "utf8"); }
export async function temporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> { const directory = await mkdtemp(path.join(os.tmpdir(), "lgtm-plugin-test-")); try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
export function execute(command: string, args: string[], cwd = repoRoot): Promise<{ code: number; stdout: string; stderr: string }> { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: "1" } }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr })); }); }
