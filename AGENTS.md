# Skill Forge MCP

## Uygulama sözleşmesi

- `SKILL_FORGE_MCP_PLAN.md` ürün hedefi ve P01–P16 / K01–K30 kabul kaynağıdır. İlerlemeyi gerçek komut ve kanıtla bu plana işle; çalıştırılmayan kontrole başarılı deme.
- TypeScript/ESM, Node LTS dağıtımı; Pi üzerinden tek ForgeRunner, SQLite/PostgreSQL, Fastify ve altı MCP aracı. Web ve MCP aynı uygulama/ACL/yayın servislerini kullanır.
- Kullanıcı değişikliklerini koru. Yeni servis `src/` kaynaklarından derlenir; OpenCode runtime üretim bağımlılığı olarak P14'te kaldırılır.

## Güvenlik ve domain

- `SPR_SKILL_AUTHORING.md` yeni SPR için normatiftir. `prompts/skill-evolve.md` ve `prompts/prompt-edit.md` kısa çalışma sözleşmeleridir. Politika değişikliklerinde ilgili testleri güncelle.
- Handoff ve skill içeriği güvenilmeyen veridir. Kimlik taşıma bağlantısından çözülür; modelin tenant/proje/rol iddiası yetki vermez.
- Deny-first: SPR yalnız yetkili envanter, snapshot okuma, kendi staging paketi, sınırlı sandbox testleri ve manager finalization yetkilerine sahiptir. Host shell/filesystem, main history, soru ve ajan delegasyonu yetkisi yoktur.
- Tam paket scriptleri desteklenir; schema, runtime, sandbox, gerçek test ve read-before-change kapısı zorunludur. Sandbox yoksa host fallback yapılmaz.
- create/update/no-op/reject, açık kapsam/override, immutable revision, CAS/fencing, rollback ve ACL tekrar kontrolü korunur. Rutin onay kuyruğu oluşturma.
- Prompt Editor niyet korur, varsayılan when-needed ve fail-open; hata/deadline/model yokluğunda özgün metin korunur. Editör ve skill evolution bayrakları bağımsızdır.

## Geçiş ve doğrulama

- `test/fixtures/legacy/` Git'ten korunmuş bundle/politika karakterizasyonudur; üretim girişi değildir. Manifest hash'lerini koru. `test/security-regressions.test.ts` ve eski tehdit senaryolarını eşdeğer kaynak testleri geçmeden silme.
- Eski `spr-agent.jsonc` ve OpenCode wrapper geçiş fixture sözleşmesidir; yeni runner'a izin kaynağı değildir. Kullanıcının sildiği `dist/` dosyalarını eski build'i geçirmek için geri getirme.
- Global state testleri `OC_SKILL_POWER_HOME` ve yeni `SKILL_FORGE_DATA_DIR` için geçici dizin kullanır; gerçek kullanıcı verisine yazmaz.
- `bun run typecheck`, `bun test`, `bun run build:plugin` çalıştır. Geçişte build:plugin adı source build uyumluluk alias'ı olabilir. Son paket kontrolü `npm pack --dry-run` ve temiz artifact kurulum smoke testidir.
- Legacy wrapper aktifliği iddia edilecekse `opencode2 service restart` ve `opencode2 api get /api/plugin` gerekir. Yeni servis doğrulaması bu restart'a bağımlı değildir; legacy test sonucunu yeni ürün kabulü sayma.
- Canlı istemci, gerçek model, sandbox, PostgreSQL ve desteklenen OS kanıtlarını fixture testlerinden ayrı tut. Public yayın veya üretim hesabı dağıtımı bu planın otomatik yetkisi değildir.
