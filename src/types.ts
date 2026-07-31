/** A currently-free Epic giveaway, as produced by `epic.ts` and rendered by `discord.ts`. */
export interface FreeGame {
  title: string;
  url: string;
  /** 16:9 key art, one slideshow frame per game. */
  imageUrl: string | null;
  endDate: string | null;
}
