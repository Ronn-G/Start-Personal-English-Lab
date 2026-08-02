import { spawnSync } from "node:child_process";

const candidates = [];
if (process.env.KOKORO_PYTHON?.trim()) {
  candidates.push([process.env.KOKORO_PYTHON.trim()]);
}
candidates.push(
  ...(process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"], ["python"]]),
);

for (const [command, ...prefix] of candidates) {
  const version = spawnSync(command, [...prefix, "--version"], {
    stdio: "ignore",
    shell: false,
  });
  if (version.error?.code === "ENOENT" || version.status !== 0) continue;
  const result = spawnSync(command, [...prefix, "tools/test_kokoro_server.py"], {
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

console.error(
  "Python 3 was not found; install it or set KOKORO_PYTHON to run the Kokoro HTTP smoke test.",
);
process.exit(1);
