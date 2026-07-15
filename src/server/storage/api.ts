import { NextResponse } from "next/server";

import { StorageError } from "./errors";

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new StorageError("VALIDATION_ERROR", "Request phải dùng application/json.");
  }
  try {
    return await request.json();
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
