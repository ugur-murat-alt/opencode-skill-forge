import { test, expect } from "bun:test";
import { zipSync } from "fflate";
import { exportPackage, importPackage } from "../src/skills/archive.js";
const files = { "SKILL.md": Buffer.from("---\nname: portable-test\ndescription: A portable archive roundtrip.\n---\n[Details](references/details.md)\n"), "references/details.md": Buffer.from("UTF-8: Türkçe, 日本語"), "assets/example.bin": Buffer.from([0, 255, 128, 10]) };
test("classic package ZIP roundtrip preserves references and binary assets", () => {
  const packed = exportPackage("portable-test", files), unpacked = importPackage(packed);
  expect(unpacked.name).toBe("portable-test"); expect(unpacked.files).toEqual(files);
});
test("ZIP import rejects traversal, multiple roots, expansion limit and symlink metadata", () => {
  expect(() => importPackage(Buffer.from(zipSync({ "../bad": new Uint8Array([1]) })))).toThrow();
  expect(() => importPackage(Buffer.from(zipSync({ "one/a": new Uint8Array([1]), "two/b": new Uint8Array([2]) })))).toThrow();
  expect(() => importPackage(Buffer.from(zipSync({ "one/bomb": new Uint8Array(5 * 1024 * 1024) })))).toThrow();
  const symlink = exportPackage("portable-test", files);
  const at = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); symlink.writeUInt32LE((0xa1ff << 16) >>> 0, at + 38);
  expect(() => importPackage(symlink)).toThrow();
});
