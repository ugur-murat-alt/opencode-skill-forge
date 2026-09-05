import { parentPort, workerData } from "node:worker_threads";
import { importPackage } from "./archive.js";
import { ForgeError } from "../domain/errors.js";
try {
  const result = importPackage(Buffer.from(workerData));
  parentPort?.postMessage({ ok: true, name: result.name, files: result.files });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    code: error instanceof ForgeError ? error.code : "invalid_archive",
    message: error instanceof ForgeError ? error.message : "ZIP açılamadı.",
  });
}
