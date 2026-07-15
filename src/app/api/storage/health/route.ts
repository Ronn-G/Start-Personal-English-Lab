import { NextResponse } from "next/server";

import { storageErrorResponse } from "@/server/storage/api";
import { getStorageHealth } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getStorageHealth());
  } catch (error) {
    return storageErrorResponse(error);
  }
}
