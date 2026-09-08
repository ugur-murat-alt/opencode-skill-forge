import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "forge-clean-artifact-"));
const reportPath =
  process.argv[2] ?? join(repo, "docs/evidence/p15-clean-package.json");
const run = async (file, args, cwd, timeout = 240000) =>
  execute(
    process.platform === "win32" && file === "npm" ? process.execPath : file,
    process.platform === "win32" && file === "npm"
      ? [
          join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
          ...args,
        ]
      : args,
    {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        SKILL_FORGE_PROFILE: "local",
        npm_config_userconfig: join(root, "npmrc"),
        npm_config_globalconfig: join(root, "global-npmrc"),
        OC_SKILL_POWER_HOME: join(root, "legacy-home"),
        SKILL_FORGE_DATA_DIR: join(root, "data"),
        npm_config_cache: join(root, "npm-cache"),
      },
    },
  );
const report = {
  captured_at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  status: "running",
};
try {
  const pack = JSON.parse(
    (await run("npm", ["pack", "--json", "--pack-destination", root], repo))
      .stdout,
  );
  const artifact = Array.isArray(pack) ? pack[0] : Object.values(pack)[0];
  report.artifact = {
    filename: artifact.filename,
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    files: artifact.files.map((f) => f.path),
  };
  const packagedPaths = artifact.files.map((file) => file.path);
  if (
    packagedPaths.some((path) =>
      /^(?:test\/|src\/|(?:dist\/)?(?:spr-agent|prompt-editor-agent)\.jsonc$|dist\/(?:plugin|skillforge-core)\.)/.test(
        path,
      ),
    )
  )
    throw Error(
      "Legacy runtime or agent configuration leaked into distribution",
    );
  if (!packagedPaths.includes("docs/tr/temiz-paket-kontrolu.md"))
    throw Error("Packaged Turkish operating guide missing");
  report.distribution_boundary = "verified";
  const install = join(root, "install");
  await mkdir(install);
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(root, artifact.filename),
    ],
    install,
  );
  // Inspect the actual installed tree, including nested dependency copies.
  const openCodePackages = [];
  const inspectModules = async (modules) => {
    let entries;
    try {
      entries = await readdir(modules, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          if (entry.name === "@opencode-ai")
            openCodePackages.push(entry.name + "/" + child.name);
          await inspectModules(join(path, child.name, "node_modules"));
        }
      } else await inspectModules(join(path, "node_modules"));
    }
  };
  await inspectModules(join(install, "node_modules"));
  report.production_opencode_packages = openCodePackages;
  if (openCodePackages.length)
    throw Error("OpenCode production dependencies remain");
  const metadata = JSON.parse(
    await readFile(join(repo, "package.json"), "utf8"),
  );
  const cli = join(install, "node_modules", metadata.name, "dist/cli.js");
  report.cli_version = (
    await run(process.execPath, [cli, "--version"], install, 10000)
  ).stdout.trim();
  if (report.cli_version !== metadata.version)
    throw Error("CLI/package version mismatch");
  const probe = `import { localConfig, createHttpServer } from ${JSON.stringify(metadata.name)};
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer } from 'node:net';
import { zipSync } from 'fflate';
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const config = await localConfig(process.env.SKILL_FORGE_DATA_DIR, port);
const app = await createHttpServer(config); const client = new Client({name:'clean-artifact-acceptance',version:'1'});
try {
 await app.listen({host:config.host,port:config.port});
 const headers = {authorization:'Bearer '+config.token};
 let health = await fetch(config.url+'/health',{headers}).then(r=>r.json());
 const deadline=Date.now()+5000; while(health.status==='checking'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,10));health=await fetch(config.url+'/health',{headers}).then(r=>r.json());}
 if(health.status!=='healthy') throw Error('health failed');
 const page = await fetch(config.url+'/').then(r=>r.text());
 if(!page.includes('Skill Forge') || !page.includes('/assets/')) throw Error('packaged web missing');
 await client.connect(new StreamableHTTPClientTransport(new URL(config.url+'/mcp'),{requestInit:{headers}}));
 const names = (await client.listTools()).tools.map(t=>t.name).sort();
 const expected = ['forge_search','forge_load','forge_run','forge_handoff','forge_report'].sort();
 if(JSON.stringify(names)!==JSON.stringify(expected)) throw Error('five-tool contract mismatch');
 const post = async (path, body) => { const r = await fetch(config.url+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)}); const data = await r.json(); if(!r.ok) throw Error('HTTP '+r.status+' '+JSON.stringify(data)); return data; };
 const project = await post('/api/projects',{name:'Clean artifact acceptance'});
 const content = ${JSON.stringify("---\nname: clean-artifact-helper\ndescription: Verify portable packaged references.\n---\nRead the registered package.\n")};
 const archive = Buffer.from(zipSync({'clean-artifact-helper/SKILL.md':Buffer.from(content)})).toString('base64');
 const published = await post('/api/skills/import',{archive,scope:'project',project_ref:project.id});
 const call = async (name,args) => { const result = await client.callTool({name,arguments:args}); if(result.isError) throw Error(JSON.stringify(result)); return JSON.parse(result.content.find(c=>c.type==='text').text); };
 const found = await call('forge_search',{project_ref:project.id,query:'portable'});
 if(!found.items.some(item=>item.skill_id===published.skill_id)) throw Error('Imported package not searchable');
 const loaded = await call('forge_load',{project_ref:project.id,skill_id:published.skill_id,revision:published.revision});
 if(!JSON.stringify(loaded).includes('Read the registered package.')) throw Error('Imported package not readable');
 console.log(JSON.stringify({health:health.status,package_integrity:health.package_integrity,tools:names,web:true,archive_worker:true,search_load:true}));
} finally { await client.close(); await app.close(); }
`;
  await writeFile(join(install, "probe.mjs"), probe);
  report.probe = JSON.parse(
    (await run(process.execPath, ["probe.mjs"], install, 30000)).stdout,
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.message).slice(0, 2000);
  process.exitCode = 1;
} finally {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, report: reportPath }));
