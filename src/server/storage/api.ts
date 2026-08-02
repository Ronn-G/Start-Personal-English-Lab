import { NextResponse } from "next/server";

import { StorageError } from "./errors";
import { ApiRequestError, readBoundedJsonBody } from "../security/local-request";

export { ApiRequestError, assertLocalMutationRequest } from "../security/local-request";

export async function readJsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  return readBoundedJsonBody(request, maxBytes);
}

export function storageErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiRequestError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof StorageError) {
    const statusByCode: Record<StorageError["code"], number> = {
      VALIDATION_ERROR: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      UNSUPPORTED_DATABASE_VERSION: 503,
      STORAGE_UNAVAILABLE: 503,
    };
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: statusByCode[error.code] },
    );
  }

  return NextResponse.json(
    { error: "Không thể truy cập bộ nhớ SQLite.", code: "STORAGE_UNAVAILABLE" },
    { status: 503 },
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
