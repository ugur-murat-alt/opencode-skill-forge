import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const execute = promisify(execFile);
const name = `forge-container-${randomUUID()}`;
const volume = `${name}-data`;
const image = process.argv[2] ?? "skill-forge-local:acceptance";
const reportPath = process.argv[3] ?? "docs/evidence/p15-container-smoke.json";
const run = async (...args) =>
  (
    await execute("docker", args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
const report = {
  image,
  profile: "local",
  platform: process.platform,
  status: "running",
};
try {
  await run("volume", "create", volume);
  await run(
    "run",
    "--detach",
    "--name",
    name,
    "--init",
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m,mode=1777",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--health-interval",
    "1s",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    image,
  );
  const ready = async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const status = JSON.parse(
        await run("inspect", "--format", "{{json .State}}", name),
      );
      if (!status.Running) throw Error("Container exited before readiness");
      if (status.Health?.Status === "healthy") return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw Error("Container readiness not reached");
  };
  await ready();
  const project = JSON.parse(
    await run(
      "exec",
      name,
      "node",
      "--input-type=module",
      "-e",
      `import fs from 'node:fs';const headers={authorization:'Bearer '+fs.readFileSync('/data/owner-token','utf8'),'content-type':'application/json'};const r=await fetch('http://127.0.0.1:38475/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Container persistence acceptance'})});if(!r.ok)throw Error('create failed');const p=await r.json();console.log(JSON.stringify({id:p.id,uid:process.getuid(),node:process.version}));`,
    ),
  );
  if (project.uid === 0) throw Error("Container is running as root");
  await run("stop", "--time", "30", name);
  const stopped = JSON.parse(
    await run("inspect", "--format", "{{json .State}}", name),
  );
  if (stopped.ExitCode !== 0) throw Error("Container shutdown failed");
  await run("start", name);
  await ready();
  await run(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `import fs from 'node:fs';const r=await fetch('http://127.0.0.1:38475/api/settings/effective?project_ref='+${JSON.stringify(project.id)},{headers:{authorization:'Bearer '+fs.readFileSync('/data/owner-token','utf8')}});if(!r.ok)throw Error('persisted project unavailable');if(fs.existsSync('/app/node_modules/@opencode-ai'))throw Error('OpenCode production dependency');console.log('verified');`,
  );
  report.runtime = project.node;
  report.uid = project.uid;
  report.health = "healthy";
  report.persistence = "verified_after_restart";
  report.image_id = await run("inspect", "--format", "{{.Image}}", name);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.message).slice(0, 1500);
  process.exitCode = 1;
} finally {
  for (const args of [
    ["rm", "--force", name],
    ["volume", "rm", volume],
  ]) {
    try {
      await run(...args);
    } catch (error) {
      if (report.status === "passed") {
        report.status = "failed";
        report.error =
          "Owned fixture cleanup failed: " +
          String(error.message).slice(0, 500);
        process.exitCode = 1;
      }
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ status: report.status, report: reportPath }));
