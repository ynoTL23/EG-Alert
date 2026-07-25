import { FREE_GAMES_PAGE_URL } from "./constants.js";
import type { FreeGame } from "./types.js";

const EPIC_BLUE = 0x2a2a2a;

function claimWindow(endDate: string | null): string | null {
  if (!endDate) return null;
  const ts = Math.floor(new Date(endDate).getTime() / 1000);
  if (!Number.isFinite(ts)) return null;
  // <t:...:R> renders as "in 6 days" in each viewer's own locale.
  return `⏳ Free until <t:${ts}:F> (<t:${ts}:R>)`;
}

export function buildEmbed(games: FreeGame[]) {
  const lines = games.map((game) => {
    const window = claimWindow(game.endDate);
    return window
      ? `🎮 **[${game.title}](${game.url})**\n${window}`
      : `🎮 **[${game.title}](${game.url})**`;
  });

  return {
    title: "🕹️ This Week's Free Games on Epic",
    url: FREE_GAMES_PAGE_URL,
    description: lines.join("\n\n"),
    color: EPIC_BLUE,
    // A single hero image reads better than N thumbnails when there are
    // multiple giveaways, so we only use one when there's exactly one game.
    ...(games.length === 1 && games[0]?.imageUrl
      ? { image: { url: games[0].imageUrl } }
      : {}),
    footer: { text: "Epic Games Store • Free every Thursday" },
    timestamp: new Date().toISOString(),
  };
}

/** `doFetch` defaults to the global — see the note on fetchFreeGames. */
export async function sendToDiscord(
  webhookUrl: string,
  games: FreeGame[],
  doFetch: typeof fetch = fetch,
): Promise<void> {
  const res = await doFetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [buildEmbed(games)] }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(`Discord webhook failed: ${res.status} ${detail}`);
  }
}
