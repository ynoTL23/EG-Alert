import { SEND_HOUR, SEND_WEEKDAY, SEND_ZONE } from "./constants.js";

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
