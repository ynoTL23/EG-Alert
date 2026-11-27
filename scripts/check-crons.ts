/**
 * Fails when wrangler.jsonc's cron could race Epic's weekly rotation.
 *
 * Epic rotates the free games at 11:00 AM Eastern, which follows DST: 15:00 UTC
 * in summer, 16:00 UTC in winter. Cloudflare crons are UTC-only, so a single
 * fixed expression has to clear the later, winter instant. Firing too early is
 * not an error anywhere else: the Worker logs "No free games" and posts nothing.
 * That happened at 15:01 UTC on 2026-09-03 and at 16:01 UTC on 2026-11-26.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// import.meta.dirname rather than new URL(...): @cloudflare/workers-types and
// @types/node declare incompatible URL types, and this sidesteps the clash.
const CONFIG_PATH = join(dirname(import.meta.dirname), "wrangler.jsonc");

/** 11:00 EST, in minutes past midnight UTC. */
const WINTER_ROTATION = 16 * 60;

/** 61s was too short on 2026-11-26. The feed's real lag is unmeasured. */
const MIN_SLACK = 10;

/** Strips // and /* *\/ comments so JSON.parse can read a .jsonc file. */
function parseJsonc(source: string): unknown {
  const stripped = source.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith('"') ? match : ""),
  );
  return JSON.parse(stripped);
}

function check(crons: string[]): string[] {
  if (crons.length !== 1) {
    return [`expected exactly one cron, found ${crons.length}`];
  }
  const cron = crons[0] ?? "";
  const [minute, hour, dayOfMonth, month, dayOfWeek, extra] = cron
    .trim()
    .split(/\s+/);
  const problems: string[] = [];

  if (extra !== undefined || dayOfWeek === undefined) {
    return [`"${cron}": expected 5 fields`];
  }
  if (dayOfMonth !== "*" || month !== "*") {
    problems.push(`"${cron}": day-of-month and month must both be "*"`);
  }
  // Quartz numbering: 1 = Sunday, so "4" is a valid expression for Wednesday.
  if (dayOfWeek !== "THU") {
    problems.push(`"${cron}": write the weekday as THU, not "${dayOfWeek}"`);
  }
  if (!/^\d+$/.test(minute ?? "") || !/^\d+$/.test(hour ?? "")) {
    problems.push(`"${cron}": minute and hour must be plain numbers`);
    return problems;
  }

  const fires = Number(hour) * 60 + Number(minute);
  const slack = fires - WINTER_ROTATION;
  if (slack < MIN_SLACK || fires >= 24 * 60) {
    problems.push(
      `"${cron}": fires ${slack} min after the 16:00 UTC winter rotation; needs at least ${MIN_SLACK}`,
    );
  }
  return problems;
}

/** `triggers.crons`, or null when the config doesn't have a string array there. */
function readCrons(config: unknown): string[] | null {
  if (typeof config !== "object" || config === null) return null;
  const triggers: unknown = "triggers" in config ? config.triggers : undefined;
  if (typeof triggers !== "object" || triggers === null) return null;
  const crons: unknown = "crons" in triggers ? triggers.crons : undefined;
  if (!Array.isArray(crons)) return null;
  return crons.every((c) => typeof c === "string") ? crons : null;
}

const crons = readCrons(parseJsonc(readFileSync(CONFIG_PATH, "utf8")));
const problems = crons
  ? check(crons)
  : ["triggers.crons is missing or not a list of strings"];

// Throw rather than process.exit(1): @cloudflare/workers-types declares
// `process` as `any`, which the type-aware lint rules reject. An uncaught
// error exits non-zero all the same.
if (problems.length > 0) {
  throw new Error(
    `wrangler.jsonc cron can race Epic's rotation:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
}

console.log(`crons ok: "${crons?.[0]}" clears the winter rotation`);
