# Hafıza oturum kancaları (Codex / Claude)

Durum: **Faz A uygulandı; native Codex/Claude kabulü yapılmadı.** Bu ortamda
`codex` ve `claude` CLI'ları kurulu değildir; aşağıdaki davranış fixture
testleri ve 11.09.2026 tarihli resmî belge kanıtıdır. Native test, gerçek
istemci sürümüyle ayrıca çalıştırılmalıdır (bkz. son bölüm).

İlgili sözleşme: `docs/adr/memory-session-hooks.md`. Kod:
`src/clients/hook-contract.ts`, `hook.ts`, `hook-spool.ts`, `hook-binding.ts`,
`worktree-binding.ts`, `installer.ts`; migration `036_memory_spool`.

## Ne yapar?

- Oturum yaşam döngüsü olaylarını işler: `SessionStart`, `UserPromptSubmit`,
  `Stop`, `SessionEnd`. (Codex `Interrupt`, `PreCompact`, `PostCompact` ve
  Claude `Interrupt`, `PreCompact`, `PostCompact` bu fazda **kurulmaz**.)
- `Stop` final mesajından **redakte edilmiş** bir oturum checkpoint'i üretir ve
  yerel dayanıklı spool'a yazar; teslim, servis erişilebilir olduğunda
  `POST /api/memory/ingest` ile idempotent yapılır.
- Mevcut davranış korunur: görünür kullanıcı prompt'u değiştirilmez,
  `Stop` skill handoff'u aynı uç ve aynı idempotency anahtarıyla çalışır.
  Hafıza capture'ı handoff'u tetiklemez; handoff hafıza capture'ı tetiklemez.
- `[memory:off]` o turun tamamında capture ve bağlam enjeksiyonunu kapatır;
  sonraki `Stop` bayrağı tüketir, sonraki tura taşınmaz.

## Olay ve sürüm tablosu

| Olay             | Codex                                                  | Claude Code                                                | Kurulur | Timeout |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ------- | ------- |
| SessionStart     | startup / resume / clear / compact                     | startup / resume / clear / compact / fork                  | Evet    | 5 sn    |
| UserPromptSubmit | prompt, turn_id                                        | prompt, prompt_id (≥ v2.1.196)                             | Evet    | 10 sn   |
| Stop             | turn_id, stop_hook_active, last_assistant_message      | stop_hook_active, last_assistant_message; kesmede çalışmaz | Evet    | 10 sn   |
| SessionEnd       | reason=other; senkron; alt ajan yok                    | clear / resume / logout / prompt_input_exit / other        | Evet    | 2 sn    |
| Interrupt        | 1–3 sn; müdahaleyi engellemez; kesilen metni kurtarmaz | Yok                                                        | Hayır   | —       |
| PreCompact       | trigger=manual / auto; context çıktısı yok             | trigger=manual / auto                                      | Hayır   | —       |
| PostCompact      | trigger=manual / auto                                  | trigger, compact_summary                                   | Hayır   | —       |
| Tool olayları    | Pre/PostToolUse, PermissionRequest…                    | Pre/PostToolUse, PermissionRequest…                        | Hayır   | —       |

Kurulmayan olaylar sessiz başarıya dönüşmez: capability raporunda
`degraded`/`unsupported` olarak işaretlenir ve istemci hook dosyasına
yazılmaz. Tanınmayan bir olay runtime'da gelirse adapter `{}` döner ve
`unsupported_event` sayacını artırır; hiçbir yerde "capture edildi" denmez.

## Kurulum

```bash
skill-forge install --client codex|claude --project <proje-dizini> --project-ref <proje-uuid>
skill-forge uninstall --client codex|claude --project <proje-dizini>
```

- Codex: `.codex/hooks.json` + `.codex/config.toml` + `AGENTS.md`.
- Claude: `.claude/settings.json` + `.mcp.json` + `CLAUDE.md`.
- Kurulum parser tabanlıdır: kullanıcı yorumları, diğer hook'lar ve
  bilinmeyen ayarlar korunur; ikinci kurulum çoğaltmaz.
- **Güven onayı kullanıcıya aittir.** Codex yönetilmeyen hook tanımlarını
  inceleme/trust olmadan çalıştırmaz; tanım değişince yeniden inceleme
  gerekir. Claude Code settings kaynaklı hook'lar için workspace trust
  ister. Araç hiçbir trust bypass bayrağı kullanmaz ve
  `hook_trust: client_review_required` sonucunu gizlemez.
- Kurulum, kalıcı binding'i `dataDir/installations/<fingerprint>/binding.json`
  dosyasına yazar (`{version, client, project_ref, directory}`). Hook komutu
  bu yüzden değişmez; yeniden kurulum yeni argv üretip trust'ı bozmaz.
- Kaldırmada yalnız aracın eklediği ve hâlâ aynı olan handler'lar silinir;
  kullanıcı sonradan değiştirdiyse dosya ve binding korunur
  (`user_changes_preserved`).

## Durumlar (karıştırılmaz)

| Durum              | Anlamı                                                | Nasıl görünür                                    |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------ |
| `installed`        | Dosyalar yazıldı, kurulum kaydı oluştu                | `install` çıktısı + `GET /api/installations`     |
| `trust_pending`    | İstemci güven incelemesi bekliyor **veya bilinmiyor** | Kullanıcı `/hooks`; ilk olaya kadar "unknown"    |
| `event_received`   | Hook olayı yerel spool'a fsync ile kabul edildi       | `memory_spool.state = pending`                   |
| `durably_accepted` | M02 kalıcı kabul/receipt oluştu                       | `GET /api/memory/events?...` → `state=committed` |
| `indexed`          | Türetilmiş görünüm hazır                              | Receipt `indexed=true`                           |

Kurulum tamamlanması hook'un güvenildiğini veya çalıştığını göstermez;
sessizlik trust kanıtı değildir.

## Teşhis

`memory_spool_counters` tablosundaki içeriksiz sayaçlar:

- `spool_full` — bounded kuyruk doldu, yeni capture reddedildi (kabul edilenler
  sessizce atılmaz).
- `content_limit`, `event_conflict`, `ingest_rejected`,
  `delivery_attempt_limit`, `capture_error`, `binding_mismatch`,
  `project_root_missing`, `unsupported_event`.

Teslim hataları yalnız kısa kodlar (`http_503`, `timeout`, `space_unavailable`,
`ingest_rejected`…) olarak `memory_spool.last_error` alanında tutulur; içerik
ve token yazılmaz. M04 (#37) durum yüzeyi bu sayaçları ve spool derinliğini
gösterir.

## Çevrimdışı ve sınırlar

- Spool yereldir ve `dataDir/local.sqlite` içindedir (server profilinde bile);
  ana hafıza kaydı değildir. Pending satırlar silinmez; terminal satırlar
  saklanır (içerik temizlenir) ve 30 gün sonra budanır.
- Daemon kapalı/ağ yokken capture birikir; sonraki hook olayı, `SessionEnd`
  veya servis açılışında bounded teslim denenir. **Anlık senkronizasyon
  değildir.**
- Hook sıcak yolunda model çağrısı yoktur; `ensureDaemon` yalnız mevcut
  `UserPromptSubmit`/`Stop` akışında kalır, hafıza capture yolu onu çağırmaz.
  Yerel ölçüm: ilk capture ~1.9 sn (tek seferlik migration), sıcak capture
  ~15–20 ms.
- Kullanıcı kesmesi (Claude `Stop` çalışmaz) ve hard-kill durumunda teslim
  alınmamış son metin için "kurtarıldı" iddiası kurulmaz.
- Codex `async` hook kullanılmaz; istemci kapandıktan sonra arka plan işine
  güvenilmez.

## `[memory:off]`

Görünür prompt'ta `[memory:off]` (büyük/küçük harf ve boşluk toleranslı)
geçerse o tur için capture ve bağlam enjeksiyonu kapanır. Prompt metni
değiştirilmez; bayrak `Stop`'ta tüketilir. Modül/capture/injection/auto-write
bayrakları bağımsızdır.

## Gizlilik

- `transcript_path` hiç okunmaz; yalnız resmî olay alanları kullanılır.
- Otomatik capture içeriği diske yazılmadan önce `sanitizeUntrustedText` ile
  redakte edilir (token, private key, Authorization/Cookie, atanmış secret).
- Token, pairing kodu ve ham özel kaynak log/rapora yazılmaz.

## Native kabul (henüz yapılmadı)

Bu ortamda native istemci yoktur. Gerçek kabul için:

1. Kurulu sürümü kaydet: `codex --version`, `claude --version`.
2. `install` sonrası istemcide güven incelemesini yap (`/hooks`).
3. Matris: startup / resume / compact, kullanıcı kesmesi, normal kapanış, hata;
   her hücrede olayın gerçekten geldiğini (heartbeat, spool, receipt) doğrula.
4. Desteklenmeyen olayları ayrıca işaretle; fixture sonuçlarını native sonuçla
   karıştırma.

Fixture kapsamı: olay yönlendirme, guard'lar, spool kabul/teslim/çakışma,
bounded kuyruk, worktree binding, kurulum/kaldırma ve `[memory:off]`.
Native kapsam: olayın istemci tarafından tetiklenmesi, trust akışı, istemci
timeout'u, `additionalContext` teslimi ve sürüm kapıları.
