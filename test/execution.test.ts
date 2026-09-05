import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DockerExecutor, command } from "../src/execution/docker.js";
import { validatePackage } from "../src/skills/validate.js";
async function fixture(runtime: "node" | "python", source: string, timeoutMs = 3000) {
  const root = await mkdtemp(join(tmpdir(), "forge-script-")), path = join(root, "package"); await mkdir(join(path, "scripts"), { recursive: true });
  const extension = runtime === "node" ? "js" : "py";
  const files = { "SKILL.md": Buffer.from("---\nname: script-test\ndescription: Test arithmetic and isolated runtime.\n---\nRead JSON from stdin; print JSON to stdout.\n"), [`scripts/main.${extension}`]: Buffer.from(source), "forge.json": Buffer.from(JSON.stringify({ version: 1, entrypoints: { calculate: { runtime, path: `scripts/main.${extension}`, inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, timeoutMs, tests: [{ name: "double", input: { x: 3 }, expected: { value: 6 } }] } } })) };
  for (const [file, content] of Object.entries(files)) await writeFile(join(path, file), content);
  return { root, path, manifest: validatePackage("script-test", files), executor: new DockerExecutor(root) };
}
for (const runtime of ["node", "python"] as const) test(`real Docker ${runtime}: JSON contract, artifact, validation and container cleanup`, async () => {
  const source = runtime === "node" ? "const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8')).x;fs.writeFileSync('/output/result.txt',String(x*2));console.log(JSON.stringify({value:x*2}));" : "import json,sys\nx=json.load(sys.stdin)['x']\nopen('/output/result.txt','w').write(str(x*2))\nprint(json.dumps({'value':x*2}))\n";
  const f = await fixture(runtime, source);
  try {
    const result = await f.executor.execute(f.path, f.manifest, "calculate", { x: 3 }); expect(result.result).toEqual({ value: 6 }); expect(result.artifacts[0]?.path).toBe("result.txt");
    expect((await f.executor.validate(f.path, f.manifest)).passed).toBe(true);
    await expect(f.executor.execute(f.path, f.manifest, "calculate", { x: "bad" })).rejects.toMatchObject({ code: "invalid_script_input" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30000);
test("real sandbox timeout kills the container and all descendants", async () => {
  const f = await fixture("node", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)", 150);
  try {
    await expect(f.executor.execute(f.path, f.manifest, "calculate", { x: 3 })).rejects.toMatchObject({ code: "script_timeout" });
    const list = await command("docker", ["ps", "--filter", "name=forge-", "--format", "{{.Names}}"], { timeoutMs: 3000 }); expect(list.stdout.split("\n").filter(name => /^forge-[0-9a-f-]+$/.test(name))).toEqual([]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 20000);
