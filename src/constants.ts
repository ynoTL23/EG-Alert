/** Values used by more than one module. Single-use constants stay in their own file. */

/**
 * The storefront's free-games landing page. Used as the embed's title link and
 * as the per-game fallback when a slug cannot be resolved.
 */
export const FREE_GAMES_PAGE_URL =
  "https://store.epicgames.com/en-US/free-games";

/**
 * When the weekly post goes out. These three are the single source of truth for
 * "Thursday 10:00 AM Eastern" — `shouldSendNow()` in `schedule.ts` enforces them
 * at runtime, and `npm run check:crons` enforces that `wrangler.jsonc`'s cron
 * expressions still match them.
 *
 * The cron expressions themselves cannot be generated from these: Cloudflare
 * crons are UTC-only and UTC has no DST, so no single expression means "10:00
 * Eastern" year-round. We register both candidate UTC hours (14:0x = EDT summer,
 * 15:0x = EST winter) and let the guard discard whichever firing is not 10:00
 * Eastern today.
 *
 * Removing either half breaks a stated requirement: drop a cron and it fires at
 * the wrong time for half the year, drop the guard and it posts twice a week.
 * See the README's schedule section.
 */
export const SEND_ZONE = "America/New_York";
export const SEND_WEEKDAY = "Thu";
export const SEND_HOUR = 10;
