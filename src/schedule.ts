/**
 * When the weekly post goes out. These three constants are the single source
 * of truth for "Thursday 10:01 AM Eastern" — change them here and the guard
 * follows.
 *
 * The cron expressions in wrangler.jsonc still have to be updated by hand to
 * match: Cloudflare crons are UTC-only and UTC has no DST, so no single
 * expression means "10:01 Eastern" year-round. We register both candidate UTC
 * hours (14:01 = EDT summer, 15:01 = EST winter) and let shouldSendNow()
 * discard whichever firing is not 10:01 Eastern today.
 *
 * Removing either half breaks a stated requirement: drop a cron and it fires
 * at the wrong time for half the year, drop the guard and it posts twice a
 * week. See the README's schedule section.
 */
const SEND_ZONE = "America/New_York";
const SEND_WEEKDAY = "Thu";
const SEND_HOUR = 10;

/**
 * True when `date` falls on the Eastern wall-clock hour we post in. Compares
 * against the real Eastern time rather than UTC, which is what makes the
 * double-cron arrangement above resolve to exactly one post per week.
 */
export function shouldSendNow(date: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEND_ZONE,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;

  return get("weekday") === SEND_WEEKDAY && Number(get("hour")) === SEND_HOUR;
}
