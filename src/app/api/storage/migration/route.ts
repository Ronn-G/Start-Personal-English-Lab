import { NextResponse } from "next/server";

import type { LegacyMigrationRecord } from "@/lib/legacy-storage-reader";
import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import { StorageError } from "@/server/storage/errors";
import { getStorageContext } from "@/server/storage";
import { commitLegacyMigration, getLegacyMigrationStatus, LEGACY_MIGRATION_ID, previewLegacyMigration } from "@/server/storage/legacy-migration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ALLOWED_RECORD_KEYS = new Set(["legacyId", "lesson", "videoId", "createdAt", "updatedAt", "progress", "progressKey", "progressUnreadable"]);

function validateRecords(value: unknown): LegacyMigrationRecord[] {
  if (!Array.isArray(value) || value.length > 500) throw new StorageError("VALIDATION_ERROR", "Danh sách migration không hợp lệ hoặc quá 500 bài.");
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some((key) => !ALLOWED_RECORD_KEYS.has(key)) || !("lesson" in item)) {
      throw new StorageError("VALIDATION_ERROR", "Migration record có field không được hỗ trợ.");
    }
  }
  return value as LegacyMigrationRecord[];
}

export async function GET() {
  try {
    return NextResponse.json({ status: getLegacyMigrationStatus(getStorageContext().database) });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request, 8_000_000);
    if (!isRecord(body) || !["dry-run", "commit"].includes(String(body.action)) || body.migrationId !== LEGACY_MIGRATION_ID) {
      throw new StorageError("VALIDATION_ERROR", "Yêu cầu migration không hợp lệ.");
    }
    const records = validateRecords(body.records);
    const database = getStorageContext().database;
    if (body.action === "dry-run") return NextResponse.json({ preview: previewLegacyMigration(database, records) });
    return NextResponse.json(commitLegacyMigration(database, records));
  } catch (error) {
    return storageErrorResponse(error);
  }
}
