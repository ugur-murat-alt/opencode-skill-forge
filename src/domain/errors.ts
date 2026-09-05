export class ForgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}
export function errorEnvelope(error: unknown) {
  return error instanceof ForgeError
    ? {
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
        },
      }
    : {
        error: {
          code: "internal_error",
          message: "İşlem tamamlanamadı; correlation kaydını inceleyin.",
        },
      };
}
