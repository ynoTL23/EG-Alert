/**
 * Fails if wrangler.jsonc's cron triggers no longer match the send time in
 * src/constants.ts.
 *
 * Nothing else enforces this pairing: Cloudflare crons are UTC-only, so the
 * expressions cannot be generated from SEND_HOUR/SEND_WEEKDAY at deploy time,
 * and a mismatch is silent — the worker just posts at the wrong hour, or never.
 * This is the check that makes the constants a real source of truth.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Explicit .ts extension: this script runs under Node's type stripping, which
// resolves specifiers against disk and so cannot follow the .js convention the
// worker sources use (those are bundled by Wrangler, which can).
import { SEND_HOUR, SEND_WEEKDAY, SEND_ZONE } from "../src/constants.ts";

// import.meta.dirname rather than new URL(...) — @cloudflare/workers-types and
// @types/node declare incompatible URL types, and this sidesteps the clash.
const CONFIG_PATH = join(dirname(import.meta.dirname), "wrangler.jsonc");

/** Cron day-of-week is 0-6 with 0 = Sunday, which is what Date.getUTCDay() returns. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The two UTC hours that can mean SEND_HOUR local time — one for each side of
 * DST. Derived by asking Intl what the zone's wall clock reads at each UTC hour
 * on a known summer and winter date, rather than hardcoding a -4/-5 offset.
 */
function expectedFirings(): { hour: number; weekday: string }[] {
  // One probe per side of DST. The ±48h sweep below covers a whole week from
  // each, so any SEND_WEEKDAY is reachable regardless of what day the probe
  // itself falls on.
  const probes = [Date.UTC(2025, 6, 1), Date.UTC(2025, 0, 1)]; // midsummer, midwinter
  const firings = new Map<string, { hour: number; weekday: string }>();

  for (const probe of probes) {
    // Sweep a full week of UTC hours from each probe. A week covers every
    // weekday, and going hour-by-hour catches send times whose UTC date differs
    // from the local one (21:00 Eastern Thursday is 01:00 UTC Friday). The Map
    // dedupes the repeats — a weekly send recurs once per 7-day sweep.
    for (let utcHour = 0; utcHour < 24 * 7; utcHour++) {
      const candidate = new Date(probe + utcHour * 3_600_000);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: SEND_ZONE,
        hour: "numeric",
        weekday: "short",
        hour12: false,
      }).formatToParts(candidate);
      const get = (type: string) => parts.find((p) => p.type === type)?.value;

      if (
        Number(get("hour")) !== SEND_HOUR ||
        get("weekday") !== SEND_WEEKDAY
      ) {
        continue;
      }
      // The UTC weekday can differ from the local one (e.g. a late-evening local
      // send rolls over midnight UTC), so take the day the cron actually needs.
      const weekday = WEEKDAYS[candidate.getUTCDay()]!;
      firings.set(`${candidate.getUTCHours()} ${weekday}`, {
        hour: candidate.getUTCHours(),
        weekday,
      });
    }
  }

  return [...firings.values()].sort((a, b) => a.hour - b.hour);
}

/** Strips // and /* *\/ comments so JSON.parse can read a .jsonc file. */
function parseJsonc(source: string): unknown {
  const stripped = source.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith('"') ? match : ""),
  );
  return JSON.parse(stripped);
}

const config = parseJsonc(readFileSync(CONFIG_PATH, "utf8")) as {
  triggers?: { crons?: string[] };
};
const crons = config.triggers?.crons ?? [];
const expected = expectedFirings();

const problems: string[] = [];

if (crons.length !== expected.length) {
  problems.push(
    `expected ${expected.length} cron expression(s) (one per DST offset), found ${crons.length}`,
  );
}

// Minute is free — it only sets how far past the hour the post lands — but every
// expression must agree on it, and hour/weekday must match the derived firings.
const minutes = new Set<string>();

for (const cron of crons) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    problems.push(`"${cron}": expected 5 cron fields, found ${fields.length}`);
    continue;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  minutes.add(minute);

  if (dayOfMonth !== "*" || month !== "*") {
    problems.push(`"${cron}": day-of-month and month must both be "*"`);
  }

  const match = expected.find(
    (e) =>
      String(e.hour) === hour &&
      WEEKDAYS.indexOf(e.weekday) === Number(dayOfWeek),
  );
  if (!match) {
    problems.push(
      `"${cron}": fires at ${hour}:${minute} UTC on day ${dayOfWeek}, which is not ${SEND_HOUR}:00 ${SEND_WEEKDAY} in ${SEND_ZONE}`,
    );
  }
}

for (const { hour, weekday } of expected) {
  const day = WEEKDAYS.indexOf(weekday);
  const covered = crons.some((cron) => {
    const [, h, , , d] = cron.trim().split(/\s+/);
    return h === String(hour) && Number(d) === day;
  });
  if (!covered) {
    problems.push(
      `missing cron for ${hour}:xx UTC on day ${day} (${weekday}) — needed to hit ${SEND_HOUR}:00 ${SEND_ZONE} on one side of DST`,
    );
  }
}

if (minutes.size > 1) {
  problems.push(
    `cron minutes disagree (${[...minutes].join(", ")}); all expressions should fire at the same minute past the hour`,
  );
}

if (problems.length > 0) {
  console.error(
    `wrangler.jsonc crons do not match SEND_* in src/constants.ts:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nExpected UTC firings for ${SEND_HOUR}:00 ${SEND_WEEKDAY} ${SEND_ZONE}:\n` +
      expected
        .map((e) => `  - "M ${e.hour} * * ${WEEKDAYS.indexOf(e.weekday)}"`)
        .join("\n") +
      `\n(M = any minute, consistent across expressions)\n`,
  );
  process.exit(1);
}

console.log(
  `crons ok: ${crons.map((c) => `"${c}"`).join(", ")} → ${SEND_HOUR}:00 ${SEND_WEEKDAY} ${SEND_ZONE}`,
);
