import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DATABASE_FILENAME = "personal-english-lab.sqlite3";

interface ResolveDataDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  homeDirectory?: string;
}

export function resolveDataDirectory({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  homeDirectory = homedir(),
}: ResolveDataDirectoryOptions = {}): string {
  const configured = env.PERSONAL_ENGLISH_LAB_DATA_DIR?.trim();
  if (configured) {
    return isAbsolute(configured) ? resolve(configured) : resolve(cwd, configured);
  }

  if (env.NODE_ENV !== "production") {
    return resolve(cwd, ".data");
  }

  if (platform === "win32") {
    const windowsBase = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
    return resolve(
      windowsBase || join(homeDirectory, "AppData", "Local"),
      "PersonalEnglishLab",
    );
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return resolve(
    xdgDataHome || join(homeDirectory, ".local", "share"),
    "personal-english-lab",
  );
}

export function resolveDatabasePath(options?: ResolveDataDirectoryOptions): string {
  return join(resolveDataDirectory(options), DATABASE_FILENAME);
}
