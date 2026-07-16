import { NextResponse } from "next/server";
import packageJson from "../../../../../package.json";
import { exportBackup } from "@/server/backup/backup";
import { getStorageContext } from "@/server/storage";
import { storageErrorResponse } from "@/server/storage/api";
export const runtime="nodejs"; export const dynamic="force-dynamic";
export async function GET(){try{const backup=exportBackup(getStorageContext().database,packageJson.version);const stamp=backup.exportedAt.replace(/[-:]/g,"").replace("T","-").slice(0,15);return new NextResponse(JSON.stringify(backup),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="personal-english-lab-backup-${stamp}.json"`,"Cache-Control":"no-store"}});}catch(e){return storageErrorResponse(e);}}
