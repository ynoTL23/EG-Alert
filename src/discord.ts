import { FREE_GAMES_PAGE_URL } from "./constants.js";
import { buildSlideshow } from "./webp.js";
import type { FreeGame } from "./types.js";

const EPIC_BLUE = 0x2a2a2a;

/** Referenced by the embed via Discord's `attachment://` scheme. */
const SLIDESHOW_FILENAME = "free-games.webp";

/**
 * Epic's cart takes one `offers` param per game, so several games claimed
 * together repeat the key: `?offers=1-a-b&offers=1-c-d`.
 */
function purchaseUrl(offers: readonly string[]): string {
  const params = offers.map((o) => `offers=${o}`).join("&");
  return `https://store.epicgames.com/purchase?${params}`;
}

function claimWindow(endDate: string | null): string | null {
  if (!endDate) return null;
  const ts = Math.floor(new Date(endDate).getTime() / 1000);
  if (!Number.isFinite(ts)) return null;
  // <t:...:R> renders as "in 6 days" in each viewer's own locale.
  return `⏳ Free until <t:${ts}:F> (<t:${ts}:R>)`;
}

export function buildEmbed(games: FreeGame[], imageUrl: string | null) {
  const lines = games.map((game) => {
    const parts = [`🎮 **[${game.title}](${game.url})**`];

    const window = claimWindow(game.endDate);
    if (window) parts.push(window);

    // Drops the game straight into the cart, so claiming is one click from
    // Discord instead of a storefront detour.
    if (game.offer) {
      parts.push(`🛒 [Instant Claim](${purchaseUrl([game.offer])})`);
    }

    return parts.join("\n");
  });

  // A cart holding every game at once. Pointless when there is only one — it
  // would just repeat the link directly above it.
  const offers = games.map((game) => game.offer).filter((o) => o !== null);
  if (offers.length > 1) {
    lines.push(`🛒 **[Instant Claim All](${purchaseUrl(offers)})**`);
  }

  return {
    title: "🕹️ This Week's Free Games on Epic",
    url: FREE_GAMES_PAGE_URL,
    description: lines.join("\n\n"),
    color: EPIC_BLUE,
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
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
  const slideshow = await buildSlideshow(games, doFetch);

  // Upload the animation with the message rather than hotlinking it: Discord
  // then hosts it, so there is no third-party URL to expire or rate-limit.
  //
  // Without one — a lone free game, or a failed build — the embed points at the
  // first game's art on Epic's CDN. Nothing is uploaded in that case.
  const embed = buildEmbed(
    games,
    slideshow
      ? `attachment://${SLIDESHOW_FILENAME}`
      : (games[0]?.imageUrl ?? null),
  );

  const form = new FormData();
  form.append("payload_json", JSON.stringify({ embeds: [embed] }));
  if (slideshow) {
    form.append(
      "files[0]",
      new Blob([slideshow], { type: "image/webp" }),
      SLIDESHOW_FILENAME,
    );
  }

  // No Content-Type header: fetch sets it, with the multipart boundary.
  const res = await doFetch(webhookUrl, { method: "POST", body: form });

  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(`Discord webhook failed: ${res.status} ${detail}`);
  }
}
