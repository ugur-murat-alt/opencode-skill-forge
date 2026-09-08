# Ajan promptlarını yönetme

Skill geliştirme ajanının sistem promptu sürümlüdür: ortam geçersiz kılmaları kuruluş varsayılanını, kuruluş varsayılanı paketlenmiş `prompts/skill-evolve.md` dosyasını ezer. Proje ortamı bilinmiyorsa (ör. silinmiş proje) zincir bir alt basamağa düşer; çalıştırma hiçbir zaman promptsuz kalmaz.

- `GET /api/agent-prompts?scope=org|environment:<id>` etkin sürüm + son 50 sürüm geçmişi.
- `PUT /api/agent-prompts` `{scope, base_version, content}` yeni sürüm yazar; taban eskimişse `revision_conflict` döner.
- `POST /api/agent-prompts/rollback` `{scope, version}` eski içeriği yeni sürüm olarak yazar; geçmiş korunur, üzerine yazma yoktur.

İçerik kuralları: boş olamaz, en fazla 32.768 karakter, karar sözlüğünü (`create`, `update`, `no-op`, `reject`, `untrusted`) taşımalıdır; aksi halde `invalid_prompt` ile reddedilir. Yazma yönetici ister. Değişiklik `agent_prompt.updated` / `agent_prompt.rollback` denetim kaydına bağlanır.
