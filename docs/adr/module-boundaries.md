# ADR: modül sahipliği, bağımlılık yönü ve genişleme sınırı

Karar: 2026-09-10 (issue #19 pilot). Modüler monolit kalınır; yeni framework,
mikroservis, plugin marketplace, CQRS veya DI container gerektirilmez.

## Sahiplik ve bağımlılık yönü

| Katman                       | Sahiplik                                                                                                                    | Yasak içe aktarma                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/domain`                 | Sözleşmeler: ayarlar, roller, hata kodları, `tool-contracts`                                                                | application, skills, jobs, runner, cli, mcp, http |
| `src/application`            | Kullanım senaryoları (identity/organization, settings, packages, maintenance, deletion, jobs orchestration, forge dispatch) | `src/mcp`, `src/http`, `src/clients`              |
| `src/skills`                 | Paket depolama, yayın/CAS, arama puanlama, revision okuma                                                                   | mcp, http, clients                                |
| `src/jobs`, `src/runner`     | Kuyruk, worker, bütçe, sağlayıcı iş akışı                                                                                   | mcp, http, clients                                |
| `src/http`, `src/mcp`, `web` | Ulaşım adaptörleri: typed uygulama işlemlerine çeviri                                                                       | —                                                 |

Kural `test/architecture-boundaries.test.ts` ile otomatik denetlenir. Örnek taşınım:
`toolSchemas` MCP adaptöründen `src/domain/tool-contracts.ts`'e taşındı; `application/forge`
artık taşıma katmanını içe aktarmaz.

## Kuyruk doğruluk kaynağı

`runs` satırı tek doğruluk kaynağıdır (fence/CAS/deadline); pg-boss yalnız teslim
araacıdır — gerekçesi ve liveness sözleşmesi `docs/adr/pg-boss-liveness.md`'dedir.

## Ortak yetenekler ve pilot

Kimlik/organizasyon, etkin politika, kuyruk, bütçe ve gözlemlenebilirlik skill'e
bağımlı olmadan çağrılabilir: `test/common-capabilities.test.ts` PackageStore ve
skill evrim runner'ına hiç dokunmadan kimlik + politika + kabul + bütçe uzlaştırmasını
kuran skill-dışı bir fixture'dır.

## Genişleme sınırı

- **Yeni ekran:** `web/src/screens.ts` kaydına tek satır; kapsam gereksinimi
  (`needsProject`) aynı tanımdan türer, ayrı liste tutulmaz.
- **Yeni sözleşme:** `src/domain`'e ekleyin; adaptörler ve uygulama oradan alır.
- **Yeni iş türü:** mevcut `JobHandler` sözleşmesi ve typed handler seçimiyle
  eklenir; ikinci kuyruk framework'ü yazılmaz.
- Pilot dikey: sözleşme taşınması (tool-contracts) + ekran kaydı + ortak yetenek
  fixture'ı bu üç ekseni gösterdi; kalan alanlar aynı yöntemle parça parça taşınır.
