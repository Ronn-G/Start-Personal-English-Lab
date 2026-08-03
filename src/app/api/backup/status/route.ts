import { NextResponse } from "next/server";

import packageJson from "../../../../../package.json";
import { inspectBackupCapacity } from "@/server/backup/backup";
import { getStorageContext } from "@/server/storage";
import { storageErrorResponse } from "@/server/storage/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      inspectBackupCapacity(getStorageContext().database, packageJson.version),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
