# Ortamlar, kapsamlar ve proje bağları

Organizasyon içinde birden çok **ortam** kurulur (`GET/POST /api/environments`, silme yalnız boş ve varsayılan-dışı ortamda). Her proje tam bir ortama aittir; yeni proje varsayılan ortama açılır veya `environment_id` ile seçilir.

## Skill ve ayar kapsamları

Skill kapsamları: `workspace`, `personal`, `project`, `environment`. Ortam skılları o ortamdaki projelere yapılan aramada görünür; başka ortamdan görünmez. Ortam ve workspace kapsamına yazma yönetici ister. Kişisel kapsam kuralları değişmedi.

Ayar katmanları (daralan limitlerle): workspace → environment → project → personal → session. Ortam kapsamı `environment:<id>` adıyla okunur/yazılır; yazma yönetici ister.

## Kapsam taşıma

`PUT /api/skills/:id/scope` `{scope, project_ref?, expected_revision}` ile açık taşınır: eski ve yeni kapsamda yetki, sürüm CAS kontrolü, hedefte ad çakışması denetimi ve denetim kaydı uygulanır. Okuyucu referansları (pin) korunur; başarısız aday aktif sürümü bozmaz.

## Proje bağları

`POST /api/projects/:id/bindings` istemci+yol eşlemesini yerel ad ve dosya parmak iziyle (`local_name`, dev:ino) kaydeder; yol kanonikleşir. `POST /api/bindings/verify` taşınmış/silinmiş dizini `stale`, kayıtsızı `unbound` döndürür. `GET /api/bindings` sahip olunan eşlemeleri listeler.
