import { NextResponse } from "next/server";

import { StorageError } from "./errors";

export async function readJsonBody(request: Request, maxBytes = 1_000_000): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new StorageError("VALIDATION_ERROR", "Request phải dùng application/json.");
  }
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maxBytes) throw new StorageError("VALIDATION_ERROR", "Request quá lớn.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      throw new StorageError("VALIDATION_ERROR", "Request quá lớn.");
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StorageError("VALIDATION_ERROR", "JSON body không hợp lệ.", {
      cause: error,
    });
  }
}

export function storageErrorResponse(error: unknown): NextResponse {
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
