# AGZ Project Management MCP

Proje adı 11.09.2026 itibarıyla **AGZ Project Management MCP** olarak güncellendi; npm paket kimliği (`@vaur94/opencode2-skill-forge`) ve `skill-forge` komutu korunur.

Bu servis; skill paketlerini saklayan, arayan ve çalıştıran, tamamlanan işten skill geliştirme görevlerini kalıcı kuyrukta yürüten bağımsız bir servistir. Node.js üzerinde HTTP/MCP servisi ve web yönetim arayüzü sağlar. OpenCode kurulumu gerekmez.

Bağımsız MCP sürümü `1.0.0`, npm'de `latest` kanalını kullanır. Bu ana sürüm eski OpenCode eklentisinden bağımsız servise kırıcı bir mimari geçiştir. Bu sürüm küçük ölçekli kullanıma açılır; geniş kullanıcı yükü, dört sağlayıcının canlı kabulü ve macOS/Windows uçtan uca doğrulaması tamamlanmış sayılmaz. [Sürüm notları](docs/tr/surum-notlari.md) çalışan kapsamı ve kalan sınırları açıklar.

## Kurulum

Node.js 24 ile:

```sh
npm install -g @vaur94/opencode2-skill-forge@latest
skill-forge login
```

Script paketlerini doğrulamak ve çalıştırmak için Docker gerekir. `login` çıktısındaki adresi tarayıcıda açıp tek kullanımlık eşleme koduyla giriş yapın. Eski OpenCode eklentisi yapılandırmasını yeni servise doğrudan taşımayın; veri aktarımı ayrı, geri alınabilir import akışını kullanır.

## Kaynaktan başlatma

Node.js 24 ve Bun gerekir. Bağımlılıklar lockfile ile sabittir. Script paketlerinin doğrulanması/çalıştırılması için Docker gerekir; Docker yoksa host üzerinde alternatif çalıştırma yapılmaz.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun test
node dist/cli.js login
```

`login`, gerekirse yerel servisi başlatır; adres ve beş dakika geçerli, tek kullanımlık eşleme kodu döndürür. Adresi tarayıcıda açıp kodla giriş yapın. Web arayüzünde proje oluşturun; istemci kurulumu için proje kimliğini kullanın. Kod ve veri dizinindeki owner token kişisel kimlik bilgileridir.

Ön planda çalıştırmak ve ayrı terminalden durumunu görmek için:

```sh
node dist/cli.js serve
node dist/cli.js doctor
```

Ön plandaki servisi Ctrl+C ile kapatabilirsiniz. Arka plandaki yerel servis için `node dist/cli.js stop` kullanın; komut kimlikli kapanış ister ve süreç çıkışını doğrular. İkinci çağrı `already_stopped` döner. Ortak sunucu profili işletim sistemi/container yöneticisiyle durdurulur. `serve` çalışırken aynı veri diziniyle ikinci bir servis başlatmayın. Özel veri dizini/port için ilgili komutlarda aynı `--data-dir /mutlak/ozel/dizin --port 38475` değerlerini kullanın. Var olan veri dizini Linux/macOS'ta kullanıcıya ait ve 0700 izinli olmalıdır.

Yerel veri konumu Linux'ta `$XDG_DATA_HOME/skill-forge` (varsayılan `~/.local/share/skill-forge`), macOS'ta `~/Library/Application Support/SkillForge`, Windows'ta `%LOCALAPPDATA%/SkillForge` olarak çözülür. `SKILL_FORGE_DATA_DIR` veya `--data-dir` ile değiştirilebilir. Linux x64/Node 24 paket kontrolü yapılmıştır; macOS/Windows uçtan uca kabulü açık iştir.

## MCP ve istemci kurulumu

Dış MCP sözleşmesi beş araçtan oluşur:

| Araç            | İşlev                                                     |
| --------------- | --------------------------------------------------------- |
| `forge_search`  | Yetkili kapsamda skill arama                              |
| `forge_load`    | Belirli immutable revision içeriğini yükleme              |
| `forge_run`     | İzinli script paketini sandbox'ta çalıştırma              |
| `forge_handoff` | Tamamlanmış işin sınırlı özetini skill incelemesine verme |
| `forge_report`  | Kalıcı iş durumunu ve sonucu okuma                        |

Stdio köprüsü `node /mutlak/skill-forge/dist/cli.js mcp` komutudur. İstemciye ham owner token yazmak gerekmez; köprü yerel servis kimliğini veri dizininden çözer. HTTP endpoint `/mcp` kimlik doğrulaması ister. Ayrıntılı çıktı/sayfalama sözleşmesi [MCP rehberindedir](docs/tr/mcp-cikti-ve-sayfalama.md).

Proje kimliğini web arayüzünde oluşturduktan sonra mevcut proje ayarlarıyla birleştiren kurulum komutunu kullanın:

```sh
node dist/cli.js install --client codex --project /mutlak/proje --project-ref PROJE_KIMLIGI
node dist/cli.js install --client claude --project /mutlak/proje --project-ref PROJE_KIMLIGI
```

Kurulum MCP ve ilgili hook ayarlarını ekler; sonradan değiştirilmiş kullanıcı ayarlarını koruyan kaldırma işlemi vardır:

```sh
node dist/cli.js uninstall --client codex --project /mutlak/proje
node dist/cli.js uninstall --client claude --project /mutlak/proje
```

Hook taşıması ve kurulum sözleşmeleri test edilmiştir; gerçek native Codex/Claude oturumlarının bütün kabul senaryoları henüz tamamlanmamıştır. ChatGPT App/widget ve canlı OAuth kabulü de açık iştir. Bu durumlar yerel MCP smoke testiyle geçmiş sayılmaz.

## Model, ayarlar ve veri

Web arayüzündeki sağlayıcı ayarları OpenAI, Anthropic, OpenRouter ve Ollama profillerini destekleyen kaynak uygulamasına bağlıdır. Sağlayıcı sırları sunucudaki şifreli kasada saklanır. Profil kaydı veya bağlantı testi, gerçek model kalite/benchmark kabulü değildir; dört sağlayıcının canlı kabul çalışmaları açıktır.

Skill geliştirme bağımsız ayarla (`evolutionEnabled`) açılıp kapatılır. Proje/personal ayarları ve veri görünürlüğü için:

- [Kullanıcılar ve yetkiler](docs/tr/kullanicilar-ve-yetkiler.md)
- [Ortamlar, kapsamlar ve proje bağları](docs/tr/ortamlar-ve-kapsamlar.md)
- [Ajan promptlarını yönetme](docs/tr/ajan-promptlari.md)
- [Eski verinin keşfi, eşlemesi ve geri alınabilir aktarımı](docs/tr/eski-veri-kesfi.md)
- [Kimlikli sunucuya veri aktarımı](docs/tr/sunucu-veri-aktarimi.md)

SQLite yerel profil, PostgreSQL ortak sunucu profili için kullanılır. Sunucu kimlik/rol modeli ve yerel owner kimliği ayrıdır. Dış OIDC sağlayıcısı ve üretim TLS dağıtımı ayrı kurulum gerektirir; yerel eşleme kodu ortak sunucuya giriş yöntemi değildir.

## Skill geliştirme ve işletim

Skill paketleri `SKILL.md` ve referans/script dosyalarından oluşur. Revision'lar immutable tutulur; script yayını schema, izinli runtime, sandbox ve gerçek test kapılarına bağlıdır. SPR kararları `create`, `update`, `no-op`, `reject` olarak ayrılır. Normatif sınırlar [SPR el kitabında](SPR_SKILL_AUTHORING.md) açıklanır.

- [Kilitli script bağımlılıkları](docs/tr/kilitli-bagimliliklar.md)
- [Paket bütünlüğü](docs/tr/paket-butunlugu.md)
- [Bakım ve paket düzenleme](docs/tr/bakim-ve-paket-duzenleme.md)
- [Worker kurtarma](docs/tr/worker-kurtarma.md)
- [Katalog benchmarkı](docs/tr/katalog-benchmarki.md)

Kalıcı kuyruk istemci bağlantısı kapandığında kabul edilmiş işi saklar; sonuç `forge_report` ile sorgulanır. Ayrı worker süreci `node dist/cli.js worker` komutuyla başlatılabilir. Worker kurtarma testleri model kalitesi kanıtı değildir. Uzun soak ölçümündeki gecikme hedefi ihlalleri ve gerçek model kalite benchmarkı açık kabul maddeleridir.

## Paketleme ve doğrulama

```sh
bun run typecheck
bun test
bun run build:plugin
npm pack --dry-run
node scripts/package-smoke.mjs
```

`build` ve `build:plugin` aynı Node tabanlı kaynak build'ini çalıştırır; ikinci ad geçiş uyumluluğu için korunur. Derlenmiş CLI kullanan testlerden önce `bun run build` çalıştırın. [Temiz paket kontrolü](docs/tr/temiz-paket-kontrolu.md), gerçek tarball'ı boş projeye üretim bağımlılıklarıyla kurar; Node HTTP/web, beş MCP aracı, ZIP worker import/search/load ve OpenCode bağımlılığının yokluğunu denetler. Gerçek script/istemci/model ve desteklenen bütün OS kabulü yerine geçmez.

Paket `dist/`, Türkçe rehberler, bu README, SPR el kitabı ve MIT lisansını içerir. Eski OpenCode agent JSONC tanımları ve test kaynakları dağıtılmaz. `test/fixtures/legacy/` hash ile korunmuş eski çekirdeği/politikayı, `test/legacy-runtime/` eski host karakterizasyon kaynaklarını barındırır. Yeni servisin üretim girişleri bunları yüklemez. Eski çekirdeğin lisans bildirimleri fixture içinde korunur; depo [MIT lisanslıdır](LICENSE).

Yerel verinin snapshot ve yeni dizine kurtarma komutları için [Yedekleme rehberi](docs/tr/yedekleme.md) bölümüne bakın. SQLite ve PostgreSQL snapshot/restore uygulanmıştır; otomatik retention ve sürümler arası geri dönüş açık kabul işleridir.
