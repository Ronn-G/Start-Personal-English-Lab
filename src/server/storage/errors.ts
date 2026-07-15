export type StorageErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED_DATABASE_VERSION"
  | "STORAGE_UNAVAILABLE";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}
