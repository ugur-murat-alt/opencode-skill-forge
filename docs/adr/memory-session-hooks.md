# ADR: Codex ve Claude oturum hook'larında hafıza sürekliliği

Durum: **Accepted — Faz A ve Faz B uygulandı; native Codex/Claude kabulü
yapılmadı.** Bu belge uygulanan Faz A/B ile kalan işleri ayrı işaretler. Tarih:
2026-09-11. İlgili issue: #38 (üst plan #33). İnceleme tabanı: `1bda764` /
dal `memory/m05-hooks`; uygulama `feat/memory-m03-m08` üzerine rebase edilmiş
dalda M01/M02/M03 sonrası yapıldı. #34/#35/#36 teslim edilmiştir; #37 durum
yüzeyi entegrasyonu ve native kabul kalan işlerdir.

Kanıt sınıfları bu belgede açıkça ayrılır:

| Sınıf              | Bu ADR'deki karşılığı                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kaynak kod         | Bu dalda okunan gerçek dosyalar; bölüm 1 ve 11'de satır aralıklarıyla anılır                                                                                                                                     |
| Resmî belge        | 11.09.2026 erişimli Codex/Claude hook sayfaları; davranış iddiaları bunlara dayanır, native test yerine geçmez                                                                                                   |
| Fixture testi      | Faz A: `hook-events-contract`, `hook-spool-delivery`, `hook-worktree-binding`, `hook-memory-off`, `hook-hot-path`, `installer-memory-events`. Faz B: `hook-context-injection` (fixture + gerçek M03 derleyicisi) |
| Gerçek native test | **Yok.** Bu ortamda `codex` ve `claude` CLI kurulu değil (`command -v` boş); `~/.codex` ve `~/.claude` dizinleri test kanıtı değildir                                                                            |

## 0. Uygulama durumu (Faz A + Faz B, 2026-09-11)

**Uygulandı:**

- `src/clients/hook-contract.ts`: istemci × olay capability tablosu, zarf
  ayrıştırma, `[memory:off]` algılama, checkpoint içeriği, event kimliği
  sözleşmesi, `promptNeedsContext` kapısı ve kaynaklı bağlam metni üreticisi.
  Kurulmayan olaylar `degraded`/`unsupported` işaretlidir.
- `src/clients/hook.ts`: olay başına yönlendirme; mevcut skill handoff ve
  statik `project_ref` bağlamı korunur; capture ayrı yoldur; guard'lar
  (`agent_id`/`agent_type`, `stop_hook_active`, bilinmeyen olay) ve
  `[memory:off]` tur davranışı uygulandı. Faz B: `SessionStart` ve koşullu
  `UserPromptSubmit` bağlam enjeksiyonu; hata/timeout'ta bağlamsız devam.
- `src/clients/context-client.ts`: M03 `GET /api/memory/context` için bounded
  istemci; şekil doğrulaması, kapsam filtresi, hata/timeout sınıflaması.
- `src/clients/context-state.ts`: offered/delivered günlüğü (atomik dosya,
  bounded); `session+generation+branch/worktree` başına `known` revizyonlar;
  resume/compact/fork yeni context-generation açar.
- `src/clients/hook-spool.ts`: yerel SQLite dayanıklı spool (kabul, bounded
  kuyruk, deterministic `event_id`, çakışma reddi, geri çekilme/terminal
  durumlar, `memory_spool`/`memory_turn_flags`/`memory_spool_counters`,
  M02 `/api/memory/ingest` teslimi); ayrıca enjeksiyon için proje-alanı çözümü
  ve `peekTurnMemoryOff`.
- `src/clients/hook-binding.ts` + `worktree-binding.ts`: kurulumda yazılan
  `binding.json` sidecar'ı ve doğrulanmış `.git → gitdir → commondir` bağı;
  branch ek bilgisi. Hook komutuna yeni argv eklenmedi.
- `src/clients/installer.ts`: capability tabanlı olay kaydı, olay başına
  timeout, binding sidecar'ı, kurulum/kaldırma raporunda capability listesi.
- `src/storage/memory-spool-migration.ts` + `036_memory_spool` kaydı;
  `/api/installations` event enum genişletmesi (yalnız bu bölüm).
- Testler: yukarıdaki yedi dosya; mevcut `installer.test.ts`,
  `hook-session.test.ts`, `prompt-removal-boundary.test.ts` yeşil kalır.

**Kalan işler:**

- M04 (#37) durum yüzeyinde spool sayaçları ve context offered/delivered
  göstergeleri; AGZ beta ile çift adapter tespiti.
- Native Codex/Claude kabul matrisi (bu ortamda istemci yok).
- Server profili/uzak hook kimliği ayrı tasarım (Faz A'dan beri açık).

**Bilinen bağımlılık:** Teslim ve enjeksiyon, proje için açılmış bir
`kind=project` memory_space bekler; yoksa capture `pending` kalır
(`space_unavailable`) ve enjeksiyon yapılmaz. Alanı açmak M02 `ensureSpace`'in
HTTP yüzeyi, M03/M07 veya arayüz işidir; M05 klasör adından alan açmaz.

Ölçülen yerel değerler (fixture, native değil): ilk capture ~1.9 sn (tek
seferlik migration), sıcak capture ortancası ~15–20 ms, sıcak `Stop` callback
< 1 sn; bağlam getirimi alan çözümü ≤300 ms + istek ≤800 ms içinde bütçelenir
ve hata durumunda enjeksiyon yapılmaz. `hook-hot-path.test.ts` ve
`hook-context-injection.test.ts` bunları sınırlar.

## 1. Mevcut hook sözleşmesi (koddan)

Bugünkü davranış, yeni hafıza olaylarının uyması gereken tabandır:

- **Giriş noktası:** `src/clients/hook.ts` → `clientHook(config, entry, client,
projectRef, input)`. CLI `src/cli/main.ts:326-345` içinde `hook --client
--project-ref --data-dir --port`; eksik argümanda `{}` yazılır.
- **Guard:** `input.agent_id`, `input.stop_hook_active` veya olay
  `UserPromptSubmit|Stop` değilse `{}` döner (hook.ts:14-19).
- **Oturum kimliği:** `session_id` string ise 200 karaktere kırpılır, yoksa
  `"unknown"` (hook.ts:20-24). `turn_id` yalnız string ise alınır, yoksa boş.
- **Daemon:** `ensureDaemon` hook sıcak yolunda çağrılır; daemon yoksa süreç
  başlatılır ve 15 sn'ye kadar `health` yoklanır (`src/cli/daemon.ts:43-74`).
- **Kurulum heartbeat'i:** `POST /api/installations`, 1 sn timeout, hata
  yutulur (hook.ts:26-42). Olay adları bu uçta kısıtlıdır:
  `installed|UserPromptSubmit|Stop|mcp_connected` (`src/http/server.ts:1087-1089`).
- **UserPromptSubmit:** görünür metin değiştirilmez (P22); yalnız
  `hookSpecificOutput.additionalContext` içinde statik `project_ref` satırı
  döner (hook.ts:43-52). `test/hook-session.test.ts` bunu ve
  `forge_prepare` çağrılmadığını doğrular.
- **Stop:** `last_assistant_message` `sanitizeUntrustedText(...,6000)` ile
  redakte edilir; `POST /api/tools/forge_handoff` çağrılır (2 sn timeout);
  idempotency `sha256([client, session, turn, summary])` (hook.ts:53-84).
  Bu, mevcut **skill handoff** yoludur ve korunur.
- **stdin:** `readHookInput` en fazla 1 MiB okur, yalnız JSON nesnesi kabul
  eder (hook.ts:89-105). `transcript_path` hiç okunmaz.
- **Kimlik:** Sunucuda `requestIdentity` Bearer token'dan çözer
  (`src/http/server.ts:51-56`); `project_ref` için `run` yetkisi doğrulanır.
  Modelin taşıdığı tenant/user/proje iddiası yetki vermez.
- **Redaksiyon:** `src/telemetry/sanitize.ts` (token, private key, Cookie,
  Authorization ve atanmış secret kalıpları; bounded truncation).
- **Installer:** `src/clients/installer.ts` jsonc-parser `modify/applyEdits` ve
  TOML blok ekleme kullanır; atomik tmp+fsync+rename, manifest+backup+lock,
  yazma öncesi içerik eşitliği kontrolü vardır. `UserPromptSubmit` ve `Stop`
  olayları **sabit listeyle** kaydedilir ve her handler `timeout: 20` taşır
  (installer.ts:198-228). Çıktı her zaman `hook_trust:
client_review_required` içerir. Uninstall yalnız manifestteki ve içeriği
  hâlâ eşleşen handler'ı kaldırır; kullanıcı değiştirdiyse
  `user_changes_preserved` döner (installer.ts:309-433).
- **Mevcut testler:** `test/hook-session.test.ts` (iki istemci için proje
  bağlamı + Stop handoff kaynak oturumları), `test/installer.test.ts`
  (yorum/setting koruma, idempotent kurulum, geri alınabilir kaldırma,
  Windows/Linux komut tırnaklama), `test/prompt-removal-boundary.test.ts`
  (`forge_prepare` negatif guard'ı).
- **Henüz olmayan:** `src/memory/**` yok; `src/domain/settings.ts` içinde
  hafıza bayrağı yok; worktree/common-dir çözümü yok; spool yok.

### 1.1 Mevcut sözleşmeyle çakışma noktaları ve kararlar

| #   | Çakışma (kanıt)                                                                                   | Karar (bu ADR)                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `session_id` yoksa `"unknown"` (hook.ts:20-24); #38 §3 bunu yasaklar ve capture atlanmasını ister | Hafıza capture'ı geçerli `session_id` yoksa **atlanır** ve tanılanır; `unknown` havuzu yok. Skill handoff mevcut davranışını korur |
| C2  | Guard yalnız iki olayı geçirir (hook.ts:14-19); yeni olaylar tümden düşer                         | Olay yönlendirmesi per-event hale getirilir; her istemci için capability tablosu kaynak olur (bölüm 3)                             |
| C3  | `ensureDaemon` sıcak yolda 15 sn'ye kadar bekleyebilir (daemon.ts:64)                             | Bağlam yolu daemon sağlıklıysa kısa deadline kullanır; capture yolu `ensureDaemon` çağırmaz, yalnız yerel spool'a yazar            |
| C4  | Stop capture'ı `forge_handoff` + `skill_evolve` kuyruğuna gider (forge.ts:264-287)                | Hafıza capture'ı bu yola **girmez**; skill handoff aynen kalır; iki döngü birbirini tetiklemez (bölüm 3.3)                         |
| C5  | Kurulum event enum'u dört değerle sınırlı (server.ts:1087-1089)                                   | Yeni olaylar için migration + strict şema genişletmesi planlanır; bilinmeyen olay sessiz kabul edilmez (bölüm 8)                   |
| C6  | Installer olay listesi ve `timeout: 20` sabit (installer.ts:200-227)                              | Capability tablosundan olay kaydı ve olay başına timeout (bölüm 8); kurulum raporu `supported/degraded/unsupported`                |
| C7  | `hookCommand` argv'si değişmeden tüm olaylara hizmet edebilir (installer.ts:102-113, 200-211)     | Tek komut + çok olay hedeflenir; yeni olay eklemek mevcut Codex trust kaydını değiştirmez, yeni handler tanımı inceleme ister      |
| C8  | `sanitizeUntrustedText` yalnız Stop özetine uygulanıyor (hook.ts:53)                              | Prompt/yotum gibi tüm serbest metin aynı sınır redaksiyonundan geçer; ham transcript hiç okunmaz                                   |
| C9  | `agent_id` ve `stop_hook_active` guard'ları var (hook.ts:15-16)                                   | Korunur ve genişletilir; alt ajan/self-origin/stop tekrarı guard'ları bölüm 7'de                                                   |
| C10 | Uninstall handler eşitliği JSON karşılaştırmasına dayanır (installer.ts:379-407)                  | Aynı yöntem yeni olaylara genişletilir; kullanıcı sonradan değiştirdiyse silinmez                                                  |

## 2. Olay × istemci yetenek matrisi (resmî belge)

Kaynaklar 11.09.2026'da erişildi:
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Claude hooks guide](https://code.claude.com/docs/en/hooks-guide).

**Sürüm durumu:** Codex sayfası sürüm numarası yayınlamaz ve üretilen
şemaların `main` dalında yayımlanmamış alanlar içerebileceğini söyler. Claude
sayfası bazı alanları v2.1.x sürümleriyle kapılar (ör. `prompt_id` ≥ v2.1.196).
**Test edilen sürüm yok**: bu ortamda iki CLI da kurulu değil; aşağıdaki
"destekliyor" ifadeleri yalnız belge kanıtıdır. Gerçek kabul, kurulu istemci
sürümü + olay kanıtıyla #38 kapanışında yapılır.

| Olay             | Codex (belge)                                                                                     | Claude Code (belge)                                                                                                                               | M05 rolü                                                           | Girdi alanları (ek)                                | Çıktı / context                                                                   | Timeout ve yürütme notu                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SessionStart     | `source=startup\|resume\|clear\|compact`; compact sonrası bir sonraki model isteğine bağlam verir | `source=startup\|resume\|clear\|compact\|fork`; `/clear` hook'ları arka planda çalışır, iptal edilirse çıktı atılır                               | Bağlam enjeksiyonu + oturum gözlemi                                | `session_id`, `cwd`, `source`, `model` (opsiyonel) | `hookSpecificOutput.additionalContext` (ikisinde); Codex'te düz stdout da context | Codex varsayılan 600 sn; Claude varsayılan 600 sn. Açık küçük timeout verilir; model çağrısı yok     |
| UserPromptSubmit | `prompt`, `turn_id`; `matcher` yok                                                                | `prompt`; `prompt_id` (≥ v2.1.196); `matcher` yok                                                                                                 | Bağlam + `[memory:off]` algılama + (capture açıksa) redakte kaynak | `prompt`, `turn_id` / `prompt_id`                  | `additionalContext` (ikisinde); blok mümkün ama **kullanılmayacak**               | Codex 600 sn varsayılan; Claude bu olayda varsayılan 30 sn. Açık timeout + kısa iç deadline          |
| Stop             | `turn_id`, `stop_hook_active`, `last_assistant_message`; `matcher` yok                            | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`; **kullanıcı kesmesinde çalışmaz**; API hatasında `StopFailure` | Checkpoint + mevcut skill handoff (ayrık)                          | `last_assistant_message`, `stop_hook_active`       | Claude `additionalContext` konuşmayı sürdürür; capture için **kullanılmaz**       | İkisinde varsayılan 600 sn; açık timeout. `stop_hook_active=true` ise capture yok                    |
| SessionEnd       | `reason=other`; **her zaman senkron**; alt ajanlarda çalışmaz; çıktı advisory                     | `reason=clear\|resume\|logout\|prompt_input_exit\|other`; çıktı (systemMessage dâhil) atılır                                                      | Son dayanıklı checkpoint işareti; bağlam yok                       | `session_id`, `cwd`                                | Model-visible context yok                                                         | Codex 1 sn varsayılan, en çok 3 sn; Claude 1.5 sn paylaşımlı bütçe, ayarla ≤60 sn'ye yükseltilebilir |
| Interrupt        | Var; alt ajanlarda çalışmaz; müdahaleyi engelleyemez                                              | Yok (kullanıcı kesmesi Stop'u çalıştırmaz)                                                                                                        | Gözlem; kesin son metin **yok**                                    | `turn_id`, `permission_mode`                       | Yalnız `systemMessage`; akış kontrolü yok                                         | Codex 1 sn varsayılan, en çok 3 sn                                                                   |
| PreCompact       | `trigger=manual\|auto`                                                                            | `trigger=manual\|auto`, `custom_instructions`                                                                                                     | Gözlem; context generation sıfırlama işareti                       | `trigger`                                          | İkisinde de bağlam eklemez (Codex'te yok; Claude karar verir)                     | Küçük açık timeout; engelleme **kullanılmayacak**                                                    |
| PostCompact      | `trigger=manual\|auto`                                                                            | `trigger`, `compact_summary`                                                                                                                      | Gözlem; bağlam sonraki `SessionStart(compact)` ile yenilenir       | `trigger`                                          | Context yok                                                                       | Küçük açık timeout                                                                                   |
| SubagentStart    | Var (`agent_id`, `agent_type`)                                                                    | Var (`agent_type` matcher)                                                                                                                        | **Kayıt yok** (ilk sürüm)                                          | —                                                  | —                                                                                 | —                                                                                                    |
| SubagentStop     | Var (`stop_hook_active`, `last_assistant_message`)                                                | Var                                                                                                                                               | **Kayıt yok**; alt ajan yalnız açık yetkiyle ileride               | —                                                  | —                                                                                 | —                                                                                                    |
| Tool olayları    | Pre/PostToolUse, PermissionRequest, PostToolUseFailure/Batch vb.                                  | Aynı aile                                                                                                                                         | **Kayıt yok**; varsayılan tam tool I/O/transcript yok              | —                                                  | —                                                                                 | —                                                                                                    |
| StopFailure      | Yok                                                                                               | Var; çıktı ve exit code yok sayılır                                                                                                               | **Kayıt yok** (ilk sürüm); ileride salt gözlem adayı               | `error`                                            | Yok                                                                               | —                                                                                                    |
| Diğer (Claude)   | —                                                                                                 | `Setup`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `Notification`, `Task*`, `Elicitation` vb.                                            | **Kayıt yok**                                                      | —                                                  | —                                                                                 | —                                                                                                    |

Ek matris notları:

- **Güven incelemesi:** Codex'te yönetilmeyen her hook tanımı kullanıcı
  incelemesi ve trust ister; trust tanımın hash'ine bağlıdır, değişen tanım
  yeniden incelenir. Proje-yerel hook'lar ancak proje `.codex/` katmanı
  güvenilirse yüklenir. Claude Code settings dosyasından gelen hook'lar için
  workspace trust kontrolü yapar. `--dangerously-bypass-hook-trust` gibi bir
  bypass bu tasarımda kullanılmaz.
- **Aynı olayda çok kaynak:** Codex tüm eşleşen kaynakları çalıştırır; aynı
  olayın birden çok command hook'u eşzamanlı başlar. Claude tüm eşleşen
  handler'ları paralel çalıştırır ve aynı handler birden çok settings
  dosyasında tanımlıysa bir kez çalışır.
- **Büyük çıktı:** Codex varsayılan ~2500 token (ayarlanabilir
  `additionalContextLimit`); Claude context/metin çıktısı 10.000 karakter
  sınırına tabidir, aşan kısım dosyaya yazılıp önizleme döner. Hafıza bağlamı
  zaten #36'da bounded üretilir; hook kendi tarafında ek şişirme yapmaz.
- **Async hook:** Codex `async: true` bitmemiş arka plan hook'larını oturum
  sonunda iptal eder ve teslim edilmemiş çıktıyı atar (aynı anda en çok 8).
  Claude async command hook timeout denetlemez, sonucu bir sonraki tura
  teslim eder, `-p` teardown'unda süreci öldürür ve aynı hook'un tekrarları
  arasında tekilleştirme yapmaz. Bu nedenle hafıza capture'ı **senkron**
  yolda yalnız yerel durable kabul yapar; istemci kapandıktan sonra arka plan
  işinin tamamlanacağına güvenilmez.

### 2.1 Desteklenmeyen olayı sessiz başarıya çevirmeme kuralı

1. **Kurulum katmanı:** Yalnız capability tablosunda `supported` olan olaylar
   yazılır. Yazılmayan olay rapora `unsupported (kaydedilmedi)` olarak girer;
   kullanıcıya "destekleniyor" izlenimi verilmez.
2. **Runtime katmanı:** Adapter `hook_event_name`'i veya zorunlu alanları
   tanımıyorsa model-visible çıktı üretmez (`{}`), yerel tanılama sayacını
   artırır (`unsupported_event_shape`) ve hiçbir yerde "capture edildi" /
   "accepted" demez. Çıktı sözleşmesinin parçası olmayan bir JSON alanı
   başarı sinyali sayılmaz.
3. **Sunucu katmanı:** Bilinmeyen olay/şema strict doğrulamada 400 döner;
   kurulum kaydı sessizce güncellenmez. `capabilities_json` yalnız gerçekten
   kaydedilmiş yetenekleri taşır.

## 3. Adapter sözleşmesi

### 3.1 Tek komut, olay başına yönlendirme

- Her istemci için **tek** hook komutu kalır: `… hook --client <codex|claude>
--project-ref <uuid> --data-dir <dir> --port <port>`. Davranış
  `hook_event_name`'e göre yönlendirilir; istemci başına ikinci bir handler
  veya ikinci bir komut üretilmez.
- İki mod ayrılır:
  - **context:** senkron, bounded, model çağrısı yok. Kaynak: #36 bağlam
    derleyicisinin sıcak cache'i veya kısa deadline'lı sorgusu. Hata/timeout
    durumunda bağlam **eklenmez** ve kullanıcı görevi devam eder (fail-open).
  - **capture:** senkron, yalnız **yerel durable kabul**. Ağ/daemon
    gerektirmez; kabul edilemezse görünür tanılama üretir, başarı iddia
    etmez (fail-visible).
- `ensureDaemon` capture yolunda çağrılmaz; bağlam yolu yalnız zaten sağlıklı
  daemon'a kısa deadline ile gider. Böylece hook callback'i hiçbir durumda
  15 sn'lik daemon başlatma beklemesine girmez.

### 3.2 Sıcak yol bütçesi (geçici; native ölçümle doğrulanacak)

| Aşama                                   | İç deadline (hedef) | Not                                             |
| --------------------------------------- | ------------------- | ----------------------------------------------- |
| stdin okuma + parse                     | ≤ 50 ms             | 1 MiB üst sınırı korunur                        |
| Yerel spool durable kabul (fsync dâhil) | ≤ 250 ms            | Capture'ın tek zorunlu adımı                    |
| Bağlam sorgusu (yalnız gerektiğinde)    | ≤ 800 ms            | Kaçırılırsa bağlam yok; yanlış/eskimış veri yok |
| Toplam hook (iç hedef)                  | ≤ 1.5 s             | İstemci timeout'u yalnız güvenlik ağı           |

İstemci tarafı timeout (kurulumda yazılacak, geçici): SessionStart 5 sn,
UserPromptSubmit 10 sn, Stop 10 sn, SessionEnd 2 sn, Interrupt 2 sn,
Pre/PostCompact 5 sn. Mevcut sabit `timeout: 20` değeri bu tabloyla
değiştirilir. Model çağrısı sayısı **sıfırdır**; bu sayı ölçülerek
kanıtlanacaktır.

### 3.3 Zarf ve tek yönlülük

- **Olay zarfı (envelope):** `version`, `installation_id`, `client`, `event`,
  `session_id`, `turn_ref`, `sequence`, `observed_at`, `content_hash`,
  `redacted_payload` (bounded), bayraklar. `transcript_path` zarf dışıdır ve
  hiç okunmaz.
- **Deterministik kimlik:** `event_id = sha256(kanonik_json(zarf künyesi +
içerik_hash))`. Retry aynı `event_id`'yi kullanır; aynı kimlik farklı
  payload ile gelirse **çakışma** olarak reddedilir, üzerine yazılmaz.
- **Tek yönlülük:** Hafıza capture'ı skill handoff tetiklemez; skill handoff
  hafıza capture tetiklemez. İki hedef ayrı uçlardır; aynı hook içinde
  birbirini çağıran iki döngü kurulmaz.
- **Çıktı disiplini:** stdout yalnız resmî hook JSON sözleşmesine uyan tek
  nesne; debug stderr; erişim tokenı, pairing kodu, ham özel içerik ve
  `transcript_path` hiçbir çıktıda yer almaz. Hafıza capture'ı hiçbir zaman
  `decision: "block"`, `continue: false` veya Stop `additionalContext`
  üretmez (yeni tur açmaz).
- **Araç yüzeyi:** Hook, MCP araç kataloğunu çağırmaz; bounded iç HTTP
  uçlarını kullanır. `memory_*` araçları #36'nın model yüzeyidir ve hook
  içinden çağrılmaz.

## 4. Kimlik, worktree ve kalıcı binding

- **Kimlik zinciri:** Hook yalnız `installation_id` (client + kanonik proje
  yolu parmak izi) ve `project_ref` taşır. Tenant/user sunucuda Bearer
  token'dan çözülür, `project_ref` için `run` yetkisi doğrulanır.
  `memory_space_id` M01 sözleşmesinden gelir. Modelin tenant/proje/rol iddiası yetki
  vermez; hook model çıktısından kimlik türetmez.
- **Proje eşleme yasağı:** Klasör adından proje türetme/otomatik oluşturma
  yoktur. `project_ref` kurulum anında sabitlenir; klasör taşınsa/klonlansa
  bile kimlik iddiası yalnız doğrulanmış bağla kurulur.
- **Worktree çözümü (`git-worktree-workspace-identity` yöntemi):** Farklı
  gerçek yollar için `.git` → `gitdir` → `commondir` zinciri bounded
  dosya okumalarıyla çözülür; karşılıklı backlink doğrulanır; worktree admin
  dizininin paylaşılan `.git` içinde olduğu gösterilir; boyut/symlink/kaçış
  ve tek yönlü sahte metadata reddedilir. Ancak bu doğrulama geçerse iki
  konum tek mantıksal workspace sayılır. Geçersiz/okunamayan metadata
  **non-equivalence**'tır: gevşek yol eşleştirmesine düşülmez, capture
  atlanır ve neden tanılanır.
- **Kapsam ayrımı:** Aynı repo'nun kalıcı kararları proje memory_space'inde
  paylaşılır; branch/worktree'ye ait tamamlanmamış görev ve checkpoint'ler
  `worktree_key` ile ayrı kapsamda tutulur. `worktree_key` kanonik worktree
  kökünden türetilir; branch adı, klasör adı veya session_id kimlik değildir.
- **Eksik/geçersiz kimlik:** Geçerli `session_id` yoksa, zarf alanları
  doğrulanamıyorsa veya worktree bağı çözülemiyorsa **capture atlanır**;
  tek `unknown` oturumuna toplama yoktur. Statik `project_ref` bağlam satırı
  mevcut sözleşmede olduğu gibi kalabilir; ancak hafıza bağlamı ve hafıza
  capture'ı gönderilmez, neden durum yüzeyine yazılır.
- **İki tenant / iki worktree:** İki ayrı kurulum kimliği ve token kapsamı
  birbirine karışmaz; aynı isimli proje/klasör kimlik sayılmaz.

## 5. Spool protokolü ve durumlar

### 5.1 İlke ve sahiplik

- Spool **ana veri değildir**: yalnız hook → daemon arasındaki yerel,
  bounded dayanıklı teslim tamponudur. Sahibi #35 (M02) dayanıklı teslim
  hattıdır; M05 yeni bir ana kayıt, ikinci kuyruk veya workflow engine
  kurmaz. #35 teslim edilmeden bu bölüm uygulanmaz.
- Konum: `dataDir` altında **yerel** depo (SQLite, WAL, `busy_timeout`,
  `synchronous=FULL`); server profilinde ana DB PostgreSQL olsa bile spool
  yereldir ve ana DB'nin yerine geçmez.
- Önerilen tablo (ad/numara M02 sırasına göre; mevcut en yüksek migration
  `031_outbox_delivery`):

  | Sütun                                                                     | Amaç                                              |
  | ------------------------------------------------------------------------- | ------------------------------------------------- |
  | `spool_id` (PK)                                                           | Yerel satır kimliği                               |
  | `installation_id`                                                         | Kurulum bağı                                      |
  | `event_id` (UNIQUE)                                                       | Deterministik idempotency anahtarı                |
  | `client`, `event`, `session_id`, `turn_ref`                               | Zarf künyesi                                      |
  | `sequence`, `observed_at`                                                 | Sıralama; eski cevabın yeni checkpoint'i ezmemesi |
  | `state`                                                                   | Kabul/teslim durumu                               |
  | `payload_redacted`                                                        | Sınırlı, redakte edilmiş içerik                   |
  | `payload_hash`                                                            | Çakışma ve bütünlük denetimi                      |
  | `attempts`, `next_attempt_at`, `lease_owner`, `lease_until`, `last_error` | Bounded teslim ve kurtarma                        |
  | `created_at`                                                              | Yaş sınırı ve tanılama                            |

- **Bounded kuyruk:** Toplam boyut/satır/yaş sınırı (geçici öneri: 32 MiB
  veya 5.000 olay, 7 gün) yapılandırılabilir olur. Sınır dolduğunda **yeni
  capture reddedilir** (`spool_full` sayacı + görünür tanılama); kabul
  edilmiş satırlar sessizce atılmaz. Disk dolu/DB kapalı durumu aynı şekilde
  görünürdür; hiçbir durumda `accepted` denmez.

### 5.2 Durumlar ve geçişler

| Durum              | Anlamı                                                  | Kanıt / sahibi                                        |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| `installed`        | Kurulum dosyaları yazıldı ve kurulum kaydı oluştu       | Installer + `POST /api/installations` yanıtı          |
| `trust_pending`    | İstemci güven incelemesi bekliyor veya durum bilinmiyor | Kullanıcı onayı; **ilk olay gözlenene kadar unknown** |
| `event_received`   | Hook olayı yerel spool'a fsync ile kabul edildi         | Hook + yerel satır; başka iddia yok                   |
| `durably_accepted` | #35 kalıcı kabul/receipt (`queued`) oluştu              | M02 teslim hattı; hook bu durumu iddia etmez          |
| `indexed`          | #36 türetilmiş görünüm (arama/graph/bağlam) hazır       | M03 + durum yüzeyi (#37)                              |

- **Kurulum ≠ güven ≠ çalıştı ≠ kabul ≠ indekslendi.** Bu beş durum ayrı
  gösterilir; hiçbiri diğerinden sessizce türetilmez. Kurulum tamamlanması
  hook'un güvenildiğini/çalıştığını göstermez; Codex'te tanım değişince
  yeniden güven incelemesi gerekir. Sessizlik ("olay gelmedi") trust kanıtı
  değildir; yalnız "unknown" olarak raporlanır.
- `trust_pending` durumu Codex `/hooks` ve Claude `/hooks` menüsünden
  kullanıcı tarafından çözülür; kurulum aracı güven onayı vermez, bypass
  etmez.

### 5.3 İdempotent teslim, sıra ve kurtarma

- **Aynı olay tam bir kez:** Aynı `event_id` tekrar teslim edilirse aynı
  receipt döner; ikinci yazım yeni revizyon üretmez. Aynı anahtar/farklı
  payload çakışmadır: ikinci payload reddedilir ve tanılanır.
- **Sıra:** Her zarf `sequence` (installation+session içinde monoton) ve
  `observed_at` taşır. Sıralaması bozuk eski cevap daha yeni checkpoint'i
  ezemez; uygulama #35 revision/CAS'ında yapılır, M05 zarfı veriyi taşır.
- **Crash kurtarma:** Süreç açılışında bounded replay/teslim M02 worker'ında
  yapılır. Hook işi bittiğinde arka plan işine güvenilmez (Codex iptal,
  Claude `-p` teardown); "son teslim alınmamış metin kurtarıldı" iddiası
  yalnız gerçekten spool'a girmiş olay için kurulur, hard-kill öncesi
  bellekte kalan içerik için kurulmaz.
- **İstemci uzun süre açılmazsa:** Teslim birikimi durum yüzeyinde görünür
  ve "anlık senkronizasyon değildir" açıklaması yapılır.

## 6. `[memory:off]` ve döngü koruması

- **`[memory:off]` bütün tur:** Kullanıcının görünür prompt'unda bu işaret
  varsa tur-kapsamlı durum yazılır (önce `session_id + turn_ref`, yoksa
  oturum kuyruğu; TTL bounded). O turda memory bağlamı eklenmez ve capture
  yapılmaz; sonraki Stop aynı durumu görür ve capture'ı atlar. Görünür özgün
  prompt **değiştirilmez**.
- **Bayrak bağımsızlığı:** Modül açık/kapalı, capture, context injection ve
  auto-write ayrı ayarlardır; birbirine bağlanmaz. `[memory:off]` yalnız o
  turun capture+injection'ını bastırır, global ayarı değiştirmez. Global
  `AGENTS.md`'ye uzun veya zorunlu hafıza metni eklenmez.
- **Döngü guard'ları:**
  - `stop_hook_active=true` → Stop capture yok (mevcut guard korunur).
  - `agent_id` / `agent_type` → capture yok; alt ajan yalnız açık yetkiyle
    ve kendi kimliğiyle kaynak verebilir (ilk sürümde hiç yok).
  - Tool olayları kayıtlı değil; `transcript_path` okunmaz.
  - Hafıza capture'ı yeni tur açan hiçbir çıktı üretmez (bölüm 3.3).
  - **Self-origin:** Hafıza servisi hook komutunu çağırmaz; `memory_*` MCP
    çağrıları hook olayı üretmez ve hook handler kendi capture'ını
    özyinelemeli tetiklemez.
  - Aynı süreç içinde capture → context → capture zinciri kurulmaz.
- **Çift adapter:** Aynı oturumda eski AGZ beta plugin'i ile yeni çekirdeğin
  birlikte injection/capture üretip üretmediği durum yüzeyinde (M04/#37)
  görünür olmalıdır; otomatik birleştirme veya sessiz bastırma yapılmaz.
  Bu, M05 kapanışında negatif testle doğrulanır.

## 7. Installer kuralları

- **Capability tabanlı olay kaydı:** Yazılacak olaylar istemci capability
  tablosundan gelir; sabit `["UserPromptSubmit", "Stop"]` listesi kaldırılır.
  Her olay `supported | degraded | unsupported` işaretlenir; yazılmayan olay
  raporda açıkça "kaydedilmedi" olarak görünür.
- **Tek komut:** Tüm olaylar aynı `hookCommand` argv'sini kullanır; olay
  başına timeout ve gerekirse istemciye özgü alanlar handler nesnesinde
  farklılaşır. Bu, Codex trust kaydını olay ekleme sırasında korur; yeni
  eklenen tanımlar ayrıca incelenir.
- **Parser tabanlı koruma:** `jsonc-parser` `modify/applyEdits` ve TOML blok
  ekleme korunur; kullanıcı yorumları, diğer hook'lar ve bilinmeyen ayarlar
  değişmez. Yazım sonrası dosya yeniden parse edilir; atomik tmp + fsync +
  rename; lock; yazma öncesi içerik eşitliği (CAS) kontrolü sürer.
- **Idempotent kurulum:** Aynı handler varsa çoğaltılmaz; yeniden kurulum
  yalnız eksik olayları ekler. Kurulum sırasında dosya değişmişse işlem
  durur (`client_config_changed`).
- **Geri alınabilir kaldırma:** Yalnız manifestteki ve içeriği hâlâ
  eşleşen handler'lar silinir; kullanıcı sonradan değiştirdiyse dosya
  korunur ve `user_changes_preserved` döner. Başka hook'lar ve kullanıcı
  ayarları asla silinmez.
- **Trust bypass yok:** `--dangerously-bypass-hook-trust` benzeri bir bayrak
  eklenmez; çıktıda `hook_trust: client_review_required` kalır; Codex hash
  değişimi ve Claude workspace trust gereksinimi dokümante edilir.
- **Sunucu kaydı:** `/api/installations` olay enum'u yeni olaylarla
  genişletilir (migration + strict zod şeması); `capabilities_json` sürüm ve
  olay yeteneklerini taşır. Heartbeat "kuruldu" kanıtı sayılmaz;
  `acceptance: not_certified_by_heartbeat` korunur.

## 8. Teşhis ve fallback

- **Durum yüzeyi (M04/#37 ile):** `installed`, trust durumu
  (unknown/required/…), son olay, olay sayaçları (`unsupported_event_shape`,
  `spool_full`, `spool_rejected` dâhil), spool derinliği ve yaşı, son teslim
  hatası, teslim gecikmesi, `[memory:off]` tur sayısı. "Gerçek zamanlı
  değildir" ve "kurulum güven/çalışma kanıtı değildir" açıklamaları zorunlu.
- **Fallback:**
  - Daemon yok/yanıt vermiyor → bağlam eklenmez, kullanıcı görevi devam
    eder; capture yerel spool'a yazılır (ağ beklenmez).
  - Spool yazılamıyor (disk/DB/limit) → `accepted` denmez; stderr tanılaması
    ve sayaç; istemci akışı bozulmaz.
  - İstemci uzun süre açılmıyor → teslim birikimi durumda görünür.
- **Çıktı ayrımı:** Paketlenen bağlam ≠ teslim edilen bağlam. Claude
  `/clear` sırasında SessionStart çıktısı iptal edilebilir, timeout çıktıyı
  atabilir, Codex async hook oturum sonunda iptal edilir. Kaybolan çıktı
  "gerekli bağlam bastırıldı" sayılmaz; sunulan paket oturum +
  context-generation ile izlenir ve durumda gösterilir.
- **Log hijyeni:** stderr yalnız kod/sayaç içerir; token, pairing kodu, ham
  özel kaynak veya `transcript_path` hiçbir log/rapora yazılmaz. Hook dış
  çıktısı güvenilmeyen veri olarak ayrıştırılır; adapter açıklaması ile not
  içeriği aynı talimat alanına birleştirilmez.

## 9. Sonraki faz için dosya ve şema önerisi

> Faz A'da uygulanan dosyalar ve şema bölüm 0'da listelenir; aşağıdaki tablo
> Faz B ve sonrası için planı korur.

| Dosya                                    | İçerik                                                                                              | Bağımlılık |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| `src/clients/hook-contract.ts`           | Olay × istemci capability tablosu; zarf tipleri ve doğrulayıcıları; timeout önerileri               | Bağımsız   |
| `src/clients/hook.ts`                    | Per-event yönlendirme; mevcut skill handoff ve guard'lar korunur; context/capture mod ayrımı        | #36, #35   |
| `src/clients/hook-spool.ts` (M02 API'si) | Yerel durable kabul, bounded kuyruk, replay; **#35 yoksa yazılmaz**                                 | #35        |
| `src/clients/worktree-binding.ts`        | Doğrulanmış common-dir çözümü; non-equivalence'ta capture atlama                                    | Bağımsız   |
| `src/storage/memory-spool-migration.ts`  | Yerel spool tablosu; numara M02 sırasına göre (şu an en yüksek `031`)                               | #35, #34   |
| `src/clients/installer.ts`               | Capability tabanlı olay kaydı; olay başına timeout; durum raporu                                    | #38 faz 2  |
| `src/http/server.ts` + migration         | `/api/installations` event enum genişletmesi; `capabilities_json` sürüm/olay alanları               | #34        |
| `test/hook-events-contract.test.ts`      | Olay şekli tanıma, desteklenmeyen şekil sayacı, çıktı disiplini                                     | Faz 2      |
| `test/hook-spool-delivery.test.ts`       | Daemon kapalı/açık, restart, duplicate/ters sıra, tam-bir-kez                                       | #35        |
| `test/hook-worktree-binding.test.ts`     | Gerçek `git worktree`; main+linked eşdeğerliği; sahte/escape/symlink reddi; iki worktree kapsamı    | Bağımsız   |
| `test/hook-memory-off.test.ts`           | Tur-kapsamlı kapatma; Stop'a taşınma; görünür prompt değişmezliği                                   | #34        |
| `test/installer-memory-events.test.ts`   | Yorum koruma, idempotent kurulum, geri alınabilir kaldırma, kullanıcı değişikliği, unsupported olay | Faz 2      |
| `docs/tr/hafiza-oturum-kancalari.md`     | Kısa kurulum, güven onayı, durum/teşhis ve fallback akışı                                           | #37        |

Not: Spool tablosu yerel SQLite'ta tutulur; server profilinde bile ana DB
(PostgreSQL) spool'un sahibi olmaz. Tablo/migration numarası #35 sırasına
göre kesinleşir; bu ADR yalnız ihtiyacı ve sütunları önerir.

## 10. Test matrisi (#38 kabul maddeleri → senaryo)

> Faz A'da koşan fixture testleri bölüm 0'dadır. `Native — yapılamaz`
> satırları hâlâ gerçek istemci bekler; fixture sonucu native kabul sayılmaz.

| #38 kabul maddesi                                                                                                      | Kanıt sınıfı (bu ortamda)                  | Senaryo / planlanan test                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Gerçek Codex/Claude sürümleriyle startup/resume/compact, kesme, kapanış, hata matrisi; desteklenmeyen olaylar işaretli | **Native — yapılamaz** (CLI yok)           | Kurulu sürümle manuel matris; fixture tarafında yalnız stdin şeması taklidi doğrulanabilir   |
| Daemon kapalı/ağ yokken durable spool; kapanıp açılınca aynı olay tam bir kez                                          | Integration (#35 sonrası)                  | Fixture sunucu + yerel spool; süreç öldür/aç; duplicate teslimde tek receipt                 |
| Ters sıra/duplicate/missing-ID, iki oturum, iki tenant, iki worktree                                                   | Integration + gerçek `git worktree`        | Hatalı/eksik kimlikte capture yok; `unknown` yok; yanlış kapsama yazma yok; stale sıra ezmez |
| Hot path'te model çağrısı sıfır; timeout ve toplam gecikme ölçümü                                                      | Unit + fixture timing (native ölçüm sonra) | Handler içinde model/HTTP zorunlu çağrı yok; bütçe tablosu (bölüm 3.2) ölçülür               |
| memory-off, alt ajan, self-origin, stop-hook tekrarlarında yasak capture/döngü yok                                     | Unit                                       | Guard testleri; `stop_hook_active`/`agent_id`; yeni tur açan çıktı yok                       |
| Installer yeniden kurma/kaldırma ve kullanıcı değişikliği; güven onayı kullanıcıda                                     | `installer.test.ts` genişletmesi + manuel  | Yorum koruma, idempotent, `user_changes_preserved`; trust manuel olarak kullanıcıda          |
| Sunulan paket ≠ iletilen paket; kayıp çıktı gerekli bağlamı bastırmaz                                                  | Unit/adapter                               | Bağlam teslim edilemezse görev devam; "sunuldu" damgası yalnız gerçek teslimde               |

Fixture sınırı: Native istemci olmadan **test edilebilenler** — olay
yönlendirme, guard'lar, zarf/idempotency, spool kabul/kurtarma, installer
merge/uninstall, worktree çözümü, çıktı disiplini, memory-off. **Native
gerektirenler** — olayın istemci tarafından gerçekten tetiklenmesi, güven
akışı, istemci timeout uygulaması, `additionalContext`'in modele ulaşması,
async iptal ve sürüm kapıları. İki sınıf kapanış raporunda karıştırılmaz.

## 11. Riskler

- **Native kanıt yok:** Belge, davranış kanıtı değildir; Codex şemaları
  `main` dalında değişebilir, Claude alanları sürüme bağlıdır. Sürüm
  matrisi ancak kurulu istemciyle doldurulur.
- **Codex trust sürtünmesi:** Yeni olay eklemek tanım hash'ini değiştirir ve
  kullanıcı incelemesi ister; kurulum otomatik "çalışıyor" diyemez.
  Yanlış anlaşılırsa kullanıcı hafızayı sessiz sanır.
- **Kesme/kapanış boşluğu:** Claude Stop kullanıcı kesmesinde çalışmaz;
  Codex Interrupt 1–3 sn ve içeriği kurtarmaz. Hard-kill öncesi teslim
  alınmamış metin için "kurtarıldı" iddiası kurulmaz; boşluk raporda açık
  olur.
- **Claude oturum akışı:** `/clear` sırasında SessionStart hook'ları arka
  planda çalışır ve yeni bir `/clear`/`/resume` ile iptal edilirse çıktı
  atılır; `additionalContext` replay'i bayat olabilir.
- **Turn eşleme:** Claude `prompt_id` ≥ v2.1.196; daha eski sürümde ve
  `Stop` tarafında tur kimliği yoktur. Session-kuyruğu fallback'i yarış ve
  bayat tur riski taşır; native testte doğrulanmalı.
- **Uzak/çok kullanıcılı kurulum:** Mevcut hook yolu yerel owner token +
  `dataDir` tabanlıdır; paylaşılan sunucuya uzaktan hook teslimi kimlik
  akışı bu ADR kapsamında değildir, ayrıca tasarlanmalıdır.
- **Çift adapter:** AGZ beta plugin'i ile aynı oturumda çift injection
  olasılığı; algılama durum yüzeyine bağlı, otomatik bastırma yok.
- **Eşzamanlı SQLite:** Hook süreci ile daemon aynı yerel spool dosyasına
  erişebilir; WAL + busy_timeout + kısa transaction şartı korunmazsa
  kilitlenme/veri kaybı riski.
- **Sabit timeout'lar:** Bu ADR'deki süreler geçicidir; native ölçümle
  sabitlenmelidir. Yanlış seçim istemciyi yavaşlatır veya capture'ı kaçırır.

## 12. Açık sorular

1. İlk sürümde kayıtlı olay kümesi ne olmalı? Öneri: `SessionStart`,
   `UserPromptSubmit`, `Stop`, `SessionEnd`; Codex'te ek olarak `Interrupt`;
   `PreCompact`/`PostCompact` yalnız gözlem. Onay gerekir.
2. Codex `SessionEnd` 3 sn sınırında yerel spool fsync güvenilir biçimde
   tamamlanır mı? Ölçüm gerekir.
3. Claude `SessionStart` matcher'sız mı (tüm source'lar) kaydedilmeli, yoksa
   `startup|resume|compact` ile mi sınırlanmalı? `fork` davranışı ne olacak?
4. `[memory:off]` işareti görünür prompt'ta kalacağı için model bunu görür;
   bu kabul mü, yoksa ayrı bir istemci ayarı mı tercih edilir?
5. `worktree_key` hangi kanonik değerden türetilmeli: git worktree admin
   dizini, realpath hash'i veya ikisinin birleşimi? M01 alan adı bekleniyor.
6. Uzak/çok kullanıcılı senaryoda hook kimliği nasıl taşınır (pairing,
   cihaz başına kimlik, token ömrü)?
7. AGZ beta adapter'ının aynı oturumda çalıştığını durum yüzeyinde
   göstermek için hangi alanlar gerekir (#37 sözleşmesi)?
8. Spool tablosu #35 tarafından mı açılacak, yoksa M05 kendi yerel tablosunu
   mu kuracak? Öneri: sahibi #35; M05 yalnız kabul API'sini tüketir.

## 13. Kaynaklar

- **Kod (bu dal, `1bda764` tabanı):** `src/clients/hook.ts`,
  `src/clients/installer.ts`, `src/cli/main.ts:326-408`,
  `src/cli/daemon.ts:43-74`, `src/http/server.ts:51-56, 1038-1151`,
  `src/application/forge.ts:264-287`, `src/telemetry/sanitize.ts`,
  `src/domain/settings.ts`, `src/storage/database.ts:92-122`;
  `test/hook-session.test.ts`, `test/installer.test.ts`,
  `test/prompt-removal-boundary.test.ts`.
- **Resmî belge (11.09.2026):**
  - Codex hooks: https://learn.chatgpt.com/docs/hooks
  - Claude Code hooks: https://code.claude.com/docs/en/hooks
  - Claude Code hooks rehberi: https://code.claude.com/docs/en/hooks-guide
- **Issue'lar:** #38 (M05), #33 (epik), #34 (M01), #35 (M02), #36 (M03),
  #37 (M04).
- **Yöntem:** `git-worktree-workspace-identity` skill'i (doğrulanmış
  common-dir bağı, non-equivalence'ta gevşek eşleşmeye düşmeme).
