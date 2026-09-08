import { test, expect } from "bun:test";
import { Throttle } from "../src/http/throttle.js";

function request(ip = "127.0.0.1") {
  return { ip, headers: {} } as any;
}

test("throttle allows within limit then rejects with 429", () => {
  const throttle = new Throttle(3, 60000);
  const req = request();
  throttle.check(req, "invite-accept");
  throttle.check(req, "invite-accept");
  throttle.check(req, "invite-accept");
  expect(() => throttle.check(req, "invite-accept")).toThrowError(
    expect.objectContaining({ code: "rate_limited" }),
  );
});

test("throttle scopes limits per key and resets after window", async () => {
  const throttle = new Throttle(1, 20);
  const req = request();
  throttle.check(req, "a");
  expect(() => throttle.check(req, "a")).toThrow();
  throttle.check(req, "b");
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  throttle.check(req, "a");
});

test("throttle keys by socket address, ignoring spoofable headers", () => {
  const throttle = new Throttle(1, 60000);
  const spoofed = () =>
    ({ ip: "127.0.0.1", headers: { "x-forwarded-for": "10.9.9.9" } }) as any;
  throttle.check(spoofed(), "a");
  expect(() => throttle.check(request(), "a")).toThrow();
});
