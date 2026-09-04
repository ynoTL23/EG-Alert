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
  /** 16:9 key art, one slideshow frame per game. */
  imageUrl: string | null;
  endDate: string | null;
}
