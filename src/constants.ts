/** Values used by more than one module. Single-use constants stay in their own file. */

/**
 * The storefront's free-games landing page. Used as the embed's title link and
 * as the per-game fallback when a slug cannot be resolved.
 */
export const FREE_GAMES_PAGE_URL =
  "https://store.epicgames.com/en-US/free-games";

/**
 * A US-cent price as "$19.99", for the embed text and the image's price tags.
 * Not `Intl.NumberFormat`: building the first one loads locale data and took
 * ~10ms when measured in Node, which is the whole CPU budget of a cron run.
 */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
