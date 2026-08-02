import { spawnSync } from "node:child_process";

const WAIVER_EXPIRES = "2026-09-30";
const ALLOWED_PRODUCTION_VULNERABILITIES = new Set(["next", "postcss", "sharp"]);
const ALLOWED_ADVISORIES = new Set([
  "GHSA-QX2V-QP2M-JG93",
  "GHSA-6G55-P6WH-862Q",
  "GHSA-R28C-9Q8G-F849",
  "GHSA-F88M-G3JW-G9CJ",
]);

if (new Date(`${WAIVER_EXPIRES}T23:59:59Z`).getTime() < Date.now()) {
  throw new Error(`Production audit waiver expired on ${WAIVER_EXPIRES}.`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error("npm_execpath is unavailable; run this policy through npm run audit:ci.");
const result = spawnSync(process.execPath, [npmCli, "audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  shell: false,
});
if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
const vulnerabilities = report.vulnerabilities ?? {};
const unexpectedPackages = Object.entries(vulnerabilities)
  .filter(([, value]) => ["high", "critical"].includes(value.severity))
  .map(([name]) => name)
  .filter((name) => !ALLOWED_PRODUCTION_VULNERABILITIES.has(name));
const advisoryIds = new Set();
for (const value of Object.values(vulnerabilities)) {
  for (const via of value.via ?? []) {
    if (typeof via !== "object" || typeof via.url !== "string") continue;
    const match = via.url.match(/GHSA-[a-z0-9-]+/i);
    if (match) advisoryIds.add(match[0].toUpperCase());
  }
}
const unexpectedAdvisories = [...advisoryIds].filter((id) => !ALLOWED_ADVISORIES.has(id));
const critical = Number(report.metadata?.vulnerabilities?.critical ?? 0);
if (critical > 0 || unexpectedPackages.length || unexpectedAdvisories.length) {
  console.error(
    JSON.stringify(
      {
        critical,
        unexpectedPackages,
        unexpectedAdvisories,
        waiverExpires: WAIVER_EXPIRES,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      status: "accepted-known-production-advisories",
      packages: [...ALLOWED_PRODUCTION_VULNERABILITIES],
      advisories: [...ALLOWED_ADVISORIES],
      reason:
        "Next.js 16.2.12 still bundles vulnerable PostCSS and Sharp versions; npm offers only an invalid breaking downgrade. The app is loopback-only and does not accept user-controlled CSS, source maps, or image optimization input.",
      expires: WAIVER_EXPIRES,
    },
    null,
    2,
  ),
);
