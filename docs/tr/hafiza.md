# Hafıza modülü — giriş noktası

Skill Forge'a gömülü, **Obsidian gerektirmeyen** Markdown tabanlı hafıza:
kaynak bağlantılı notlar, tipli ilişkiler, sürümlü kabul, graph/backlink,
oturum sürekliliği ve kontrollü otomasyon. Vault dosya ağacıdır; uygulama,
eklenti veya harici sync zorunluluğu yoktur.

**Durum:** M01–M08 uygulama yarısı bu depoda; kalite/token/latency ölçümü ve
gerçek Codex/Claude native kabulü ayrı çalışmalardır. Eski kampanya kanıtları
güncel rehber yerine geçmez.

## Rehberler

| Konu                                  | Belge                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| Kullanıcı akışları ve kavramlar       | [`hafiza-format.md`](hafiza-format.md)                     |
| MCP araç/API referansı                | [`hafiza-mcp-referansi.md`](hafiza-mcp-referansi.md)       |
| Vault dosya düzeni ve çalışma kopyası | [`hafiza-dosya-duzeni.md`](hafiza-dosya-duzeni.md)         |
| Codex/Claude oturum kancaları         | [`hafiza-oturum-kancalari.md`](hafiza-oturum-kancalari.md) |
| Küratör (çıkarım/otomasyon)           | [`hafiza-curator.md`](hafiza-curator.md)                   |
| İşletim: saklama/unutma/yedek/doctor  | [`hafiza-isletim.md`](hafiza-isletim.md)                   |
| AGZ geçişi                            | [`hafiza-agz-gecisi.md`](hafiza-agz-gecisi.md)             |
| Kabul ve kanıt sınıfları              | [`hafiza-kabul.md`](hafiza-kabul.md)                       |

## Sözleşmeler (ADR)

- Sahiplik ve alan/kimlik modeli: `docs/adr/memory-ownership.md`
- Dayanıklı kayıt/commit hattı: `docs/adr/memory-pipeline.md`
- Oturum kancaları ve bağlam enjeksiyonu: `docs/adr/memory-session-hooks.md`
- Küratör profili ve otomasyon politikası: `docs/adr/memory-curator.md`

## Kısa kurulum ve doğrulama

1. `skill-forge login` ve `skill-forge install --client codex|claude --project <dizin> --project-ref <uuid>`.
2. İstemcide hook güven incelemesini kullanıcı yapar (`/hooks`).
3. `GET /api/memory/health?space_id=…` içeriksiz durum; `memory_context`,
   `memory_recall`, `memory_read`, `memory_update`, `memory_link`,
   `memory_checkpoint` araçları MCP istemcisinde açık çağrıyla kullanılabilir.

## Sınırlar

- Otomatik çıkarım yalnız açık politika (`memoryCuratorMode`) ve model bağı
  varsa çalışır; model yoksa manuel hafıza çalışır.
- Kabul edilmiş notlar retention ile silinmez; unutma açık `purge` işlemidir.
- Yedeklerde purge öncesi kopya kalabilir; güvenli restore purge kaydı ve
  uzlaştırma gerektirir (`hafiza-isletim.md`).
