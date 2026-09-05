# Eski davranışların dönüşüm matrisi

| Davranış | Karar | Eski karakterizasyon | Yeni sahip / kabul |
|---|---|---|---|
| traversal/symlink/alias/root confinement | preserve | security-regressions: support path confinement | skills paket doğrulama, K08 |
| read-before-change ve stale dosya koruma | preserve | security-regressions: support/skill changed after view | immutable revisions + staging, K04/K08 |
| yalnız hedef skill rollback | preserve | security-regressions: rollback sibling/commit recheck | CAS publisher/reconciliation, K02/K04 |
| journal/path uyuşmazlığı ve no-change mutasyonu | preserve | security-regressions: finalize/journal failures | hash'e bağlı finalize, K02/K05 |
| süreç içi source/session dedup | replace | spr-handoff + core-runtime | durable acceptance/lease/fencing, K01–K04 |
| otomatik session idle/host tool gizleme | remove | spr-handoff/core-runtime | yalnız explicit final handoff, K01/K18 |
| model ayrı gizli OpenCode session | replace | prompt-editor runner/setup | Pi ForgeRunner, K09/K14 |
| bounded context/sanitization | preserve | context-snapshot/workspace-context/capabilities | yetkili sağlanan context, K11/K12 |
| intent fail-open ve cancellation | preserve | runtime/context-hook/manual-approval | prepare immutable original/deadline, K11 |
| zorunlu farklı prompt ve her tur öğrenme | remove | config/system/learn legacy assertions korunur | when-needed + reusable-only, K09/K11 |
| rutin modal approval | remove | approval-gate/manual-approval legacy | politika kontrollü otomatik sonuç, K26/K28 |
| host part.update ve web bridge | remove | persist/rewrites/live | resmi istemci result formatı, K17–K19 |
| rewrite JSONL ve learn.md | migrate | rewrites/learn | checksum'lı özel scope import, K25 |
| global/proje skill ve flags | migrate | guards/core-options/spr-options | scope/binding/override/config, K12/K27 |
| managed/pinned/protected | preserve | security-regressions/SPR policy | yeni domain karar kapısı, K13 |
| bütün user-owned skill'i reddetme | replace | legacy SPR policy | explicit managed yetkisi, K13 |
| executable script mutasyon yasağı | replace | security-regressions: forbids background scripts | manifest/sandbox/gerçek hash bağlı test, K05/K07/K08 |
| create/update/no-op/reject | preserve | spr-authoring-policy | evolution-policy + runner, K09 |
| native Linux yardımcı artifact | replace | bundle protocol/hash probe | platforma uygun sandbox adapter, K07/K25 |

Legacy testlerin geçmesi yeni API eşdeğerliği değildir. Yeni sahip sütunundaki
bağlantılar uygulama ve acceptance ilerledikçe plan kanıtıyla tamamlanır.
