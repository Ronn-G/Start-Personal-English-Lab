import type { DatabaseSync } from "node:sqlite";

import { openStorageDatabase } from "./database";
import { CURRENT_DATABASE_VERSION } from "./migrations";
import { SqliteStorageRepository } from "./sqlite-repository";

interface StorageContext {
  database: DatabaseSync;
  repository: SqliteStorageRepository;
  schemaVersion: number;
}

let storageContext: StorageContext | undefined;

export function getStorageContext(): StorageContext {
  if (!storageContext) {
    const { database, schemaVersion } = openStorageDatabase();
    storageContext = {
      database,
      repository: new SqliteStorageRepository(database),
      schemaVersion,
    };
  }
  return storageContext;
}

export function getStorageHealth(): {
  status: "ok";
  driver: "node:sqlite";
  schemaVersion: number;
  supportedSchemaVersion: number;
} {
  const { database, schemaVersion } = getStorageContext();
  database.prepare("SELECT 1 AS ok").get();
  return {
    status: "ok",
    driver: "node:sqlite",
    schemaVersion,
    supportedSchemaVersion: CURRENT_DATABASE_VERSION,
  };
}
