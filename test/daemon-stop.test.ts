import { test, expect } from "bun:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
const exec = promisify(execFile);
test("Node daemon stop: owner-only shutdown, exit, idempotence, restart and retained data", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-stop-"));
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const cli = resolve("dist/cli.js"),
    args = ["--data-dir", root, "--port", String(port)];
  const env = {
    ...process.env,
    SKILL_FORGE_PROFILE: "local",
    OC_SKILL_POWER_HOME: join(root, "legacy"),
  };
  let child: ReturnType<typeof spawn> | undefined;
  const start = async () => {
    child = spawn("node", [cli, "serve", ...args], { env, stdio: "ignore" });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const token = await readFile(join(root, "owner-token"), "utf8");
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.ok) return token;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw Error("Fixture did not start");
  };
  try {
    const token = await start(),
      url = `http://127.0.0.1:${port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const project = (await fetch(url + "/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Preserved on stop" }),
    }).then((r) => r.json())) as { id: string };
    expect(typeof project.id).toBe("string");
    expect(
      (
        await fetch(url + "/api/service/stop", {
          method: "POST",
          headers: { authorization: "Bearer incorrect" },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(url + "/health", { headers })).ok).toBe(true);
    const pairing = (await fetch(url + "/api/pairing", {
      method: "POST",
      headers: { authorization: headers.authorization },
    }).then((r) => r.json())) as { code: string };
    const paired = await fetch(url + "/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code }),
    });
    const session = (await paired.json()) as { csrf: string };
    const cookies = paired.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(
      (
        await fetch(url + "/api/service/stop", {
          method: "POST",
          headers: { cookie: cookies, "x-forge-csrf": session.csrf },
        })
      ).status,
    ).toBe(403);
    const stopped = await exec("node", [cli, "stop", ...args], {
      env,
      timeout: 20000,
    });
    expect(JSON.parse(stopped.stdout).status).toBe("stopped");
    expect(child!.exitCode).toBe(0);
    await expect(fetch(url + "/health", { headers })).rejects.toThrow();
    expect(
      JSON.parse(
        (await exec("node", [cli, "stop", ...args], { env, timeout: 8000 }))
          .stdout,
      ).status,
    ).toBe("already_stopped");
    expect(await start()).toBe(token);
    const settings = await fetch(
      url + "/api/settings/effective?project_ref=" + project.id,
      { headers },
    );
    expect(settings.ok).toBe(true);
    await exec("node", [cli, "stop", ...args], { env, timeout: 20000 });
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
