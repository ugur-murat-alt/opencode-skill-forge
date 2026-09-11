/**
 * Bağımsız M02 yazıcı kilidi çocuğu (probe, üretim kodu değil).
 *
 * Vault kilidini gerçekten alır, LOCKED yazar ve süreç öldürülene/SIGSTOP
 * alana kadar bekler. Ebeveyn testi canlı pid, duraklatılmış canlı yazıcı ve
 * ölü pid devralma davranışını bu süreç üzerinden doğrular.
 */
import { VaultWriter } from "../../../src/memory/writer.js";

const vault = process.env.VAULT;
if (!vault) throw new Error("missing env VAULT");
const leaseMs = Number(process.env.LEASE_MS ?? "400");
const writer = new VaultWriter(vault, { leaseMs });
const lease = await writer.acquire();
console.log("LOCKED");
await new Promise(() => {});
void lease;
