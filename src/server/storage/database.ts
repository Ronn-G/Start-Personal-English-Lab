import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDatabasePath } from "./data-directory";
import { runMigrations } from "./migrations";

export interface OpenDatabaseResult {
  database: DatabaseSync;
  schemaVersion: number;
}

export function openStorageDatabase(databasePath = resolveDatabasePath()): OpenDatabaseResult {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const schemaVersion = runMigrations(database);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    return { database, schemaVersion };
  } catch (error) {
    database.close();
    throw error;
  }
}
