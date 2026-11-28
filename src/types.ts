/** A currently-free Epic giveaway, as produced by `epic.ts` and rendered by `discord.ts`. */
export interface FreeGame {
  title: string;
  url: string;
  /**
   * The `1-<namespace>-<id>` cart fragment for this game. Null when Epic omits
   * either id. `discord.ts` turns it into a per-game link, and joins several
   * with `&` into one claim-all link.
   */
  offer: string | null;
  /** 16:9 key art: one tile of the collage, or one slideshow frame. */
  imageUrl: string | null;
  /** The live promotional window, ISO 8601. The image's date chip reads both. */
  startDate: string | null;
  endDate: string | null;
  /** Usual price in US cents, never zero. Null when Epic gives no list price. */
  price: number | null;
}
