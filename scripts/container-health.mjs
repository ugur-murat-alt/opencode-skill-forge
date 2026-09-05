import http from "node:http";
const port = Number(process.env.SKILL_FORGE_PORT ?? 38475);
const host =
  process.env.SKILL_FORGE_PROFILE === "server"
    ? new URL(process.env.SKILL_FORGE_PUBLIC_URL).host
    : `127.0.0.1:${port}`;
const request = http.get(
  {
    hostname: "127.0.0.1",
    port,
    path: "/health/ready",
    headers: { host },
    timeout: 4000,
  },
  (response) => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  },
);
request.on("timeout", () => request.destroy(new Error("readiness timeout")));
request.on("error", () => {
  process.exitCode = 1;
});
