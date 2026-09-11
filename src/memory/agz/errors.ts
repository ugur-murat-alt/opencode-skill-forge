/**
 * AGZ kaynak envanteri hata kodları.
 *
 * Bu modül yalnız salt-okunur kaynak erişimi içindir; hiçbir hata yolu
 * kaynak dosyada mutasyon üretmez. `unsupported_source_schema` dahil bütün
 * reddetme kararları kaynak açılmadan veya yalnız okunarak verilir.
 */

export type AgzSourceErrorCode =
  | "unsupported_source_schema"
  | "source_identity_mismatch"
  | "source_integrity_failed"
  | "source_not_found"
  | "source_path_unsafe"
  | "source_snapshot_not_frozen"
  | "source_changed_during_scan"
  | "invalid_cursor";

export class AgzSourceError extends Error {
  readonly code: AgzSourceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AgzSourceErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AgzSourceError";
    this.code = code;
    this.details = details;
  }
}
