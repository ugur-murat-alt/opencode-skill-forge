import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerExecutor } from "../src/execution/docker.js";
import { validatePackage } from "../src/skills/validate.js";
test("real isolated egress: allowlisted HTTPS succeeds; other origins and direct sockets are blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-egress-")),
    path = join(root, "package");
  await mkdir(join(path, "scripts"), { recursive: true });
  const source = `const net=require('net');(async()=>{const allowed=(await fetch('https://registry.npmjs.org/is-number/7.0.0',{signal:AbortSignal.timeout(5000)})).status===200;let denied=false;try{await fetch('https://example.com',{signal:AbortSignal.timeout(2000)})}catch{denied=true}const directBlocked=await new Promise(resolve=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',()=>resolve(true));socket.once('timeout',()=>{socket.destroy();resolve(true)})});console.log(JSON.stringify({allowed,denied,directBlocked}))})().catch(()=>process.exit(2));`;
  const files = {
    "SKILL.md": Buffer.from(
      "---\nname: limited-network\ndescription: Read allowed package metadata through isolated egress.\n---\nOnly registered origin may be reached.\n",
    ),
    "scripts/network.js": Buffer.from(source),
    "forge.json": Buffer.from(
      JSON.stringify({
        version: 1,
        entrypoints: {
          probe: {
            runtime: "node",
            path: "scripts/network.js",
            network: ["https://registry.npmjs.org"],
            timeoutMs: 10000,
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: {
                allowed: { type: "boolean" },
                denied: { type: "boolean" },
                directBlocked: { type: "boolean" },
              },
              required: ["allowed", "denied", "directBlocked"],
            },
            tests: [
              {
                name: "policy",
                input: {},
                expected: { allowed: true, denied: true, directBlocked: true },
              },
            ],
          },
        },
      }),
    ),
  };
  try {
    for (const [file, bytes] of Object.entries(files))
      await writeFile(join(path, file), bytes);
    const manifest = validatePackage("limited-network", files);
    await expect(
      new DockerExecutor(root).execute(path, manifest, "probe", {}),
    ).rejects.toMatchObject({ code: "network_policy_denied" });
    const result = await new DockerExecutor(root, {
      trustScope: "test",
      allowDependencyInstall: false,
      allowedOrigins: ["https://registry.npmjs.org"],
    }).execute(path, manifest, "probe", {});
    expect(result.result).toEqual({
      allowed: true,
      denied: true,
      directBlocked: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
