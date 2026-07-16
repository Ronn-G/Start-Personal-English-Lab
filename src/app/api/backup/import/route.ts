import { NextResponse } from "next/server";
import { importBackup, previewImport } from "@/server/backup/backup";
import { getStorageContext } from "@/server/storage";
import { isRecord, readJsonBody, storageErrorResponse } from "@/server/storage/api";
import { StorageError } from "@/server/storage/errors";
export const runtime="nodejs"; export const dynamic="force-dynamic";
let busy=false;
export async function POST(request:Request){try{const body=await readJsonBody(request,8_500_000);if(!isRecord(body)||!["dry-run","merge","replace"].includes(String(body.action))||!("backup" in body))throw new StorageError("VALIDATION_ERROR","Yêu cầu import không hợp lệ.");const db=getStorageContext().database;if(body.action==="dry-run")return NextResponse.json({preview:previewImport(db,body.backup)});if(busy)throw new StorageError("CONFLICT","Một import khác đang chạy.");if(body.action==="replace"&&body.confirmReplace!==true)throw new StorageError("VALIDATION_ERROR","Replace all cần xác nhận rõ ràng.");busy=true;try{return NextResponse.json({preview:importBackup(db,body.backup,body.action as "merge"|"replace",body.allowRepeat===true)});}finally{busy=false;}}catch(e){return storageErrorResponse(e);}}
