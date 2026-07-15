declare module "node:sqlite" {
  export interface StatementSync {
    all(...anonymousParameters: unknown[]): unknown[];
    get(...anonymousParameters: unknown[]): unknown;
    run(...anonymousParameters: unknown[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; timeout?: number });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
