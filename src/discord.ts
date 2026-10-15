import { FREE_GAMES_PAGE_URL } from "./constants.js";
import { buildSlideshow } from "./webp.js";
import type { FreeGame } from "./types.js";

const EPIC_BLUE = 0x0078f2;

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

/**
 * Long titles wrap the three-column field grid into a tower. Cut at a word
 * boundary so the ellipsis lands between words.
 */
function shortTitle(title: string, max = 40): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const kept = space > max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s:—–-]+$/, "")}…`;
}

function claimWindow(endDate: string | null): string | null {
  if (!endDate) return null;
  const ts = Math.floor(new Date(endDate).getTime() / 1000);
  if (!Number.isFinite(ts)) return null;
  // <t:...:R> renders as "in 6 days" in each viewer's own locale.
  return `⏳ Free until <t:${ts}:F> (<t:${ts}:R>)`;
}

/** Everything shown for a game beneath its title. */
function details(game: FreeGame): string[] {
  const parts: string[] = [];

  const window = claimWindow(game.endDate);
  if (window) parts.push(window);

  // Drops the game straight into the cart, so claiming is one click from
  // Discord instead of a storefront detour.
  if (game.offer) {
    parts.push(`🛒 [Instant Claim](${purchaseUrl([game.offer])})`);
  }

  return parts;
}

export function buildEmbed(games: FreeGame[], imageUrl: string | null) {
  // A lone inline field renders as a narrow column against empty space, so one
  // game keeps the plain description layout.
  const [first] = games;
  const body =
    games.length === 1 && first
      ? {
          description: [
            `**[${first.title}](${first.url})**`,
            ...details(first),
          ].join("\n"),
        }
      : multiGameBody(games);

  return {
    title: "🕹️ This Week's Free Games on Epic",
    url: FREE_GAMES_PAGE_URL,
    ...body,
    color: EPIC_BLUE,
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
    footer: { text: "Epic Games Store • Free every Thursday" },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Inline fields sit side by side, up to three per row — Epic's usual weekly
 * count. Field names don't render markdown links, so the store link moves
 * into the value.
 */
function multiGameBody(games: FreeGame[]) {
  return {
    fields: games.map((game) => ({
      name: shortTitle(game.title),
      value: [`[Store page](${game.url})`, ...details(game)].join("\n"),
      inline: true,
    })),
  };
}

/**
 * A cart holding every game at once, as a link button below the embed: one
 * unmistakable target instead of one blue link among many. Pointless when there
 * is only one game — it would repeat that game's own claim link.
 *
 * Link buttons (style 5) are always grey; every coloured style needs a
 * `custom_id`, and so an application with an interaction endpoint.
 */
function claimAllButton(games: FreeGame[]) {
  const offers = games.map((game) => game.offer).filter((o) => o !== null);
  if (offers.length < 2) return [];
  return [
    {
      type: 1, // action row
      components: [
        {
          type: 2, // button
          style: 5, // link
          label: `Claim all ${offers.length} games`,
          emoji: { name: "🛒" },
          url: purchaseUrl(offers),
        },
      ],
    },
  ];
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
  const components = claimAllButton(games);
  form.append(
    "payload_json",
    JSON.stringify({
      embeds: [embed],
      ...(components.length ? { components } : {}),
    }),
  );
  if (slideshow) {
    form.append(
      "files[0]",
      new Blob([slideshow], { type: "image/webp" }),
      SLIDESHOW_FILENAME,
    );
  }

  // A webhook made in Server Settings isn't application-owned, so Discord
  // drops `components` — with a 200 and nothing logged — unless this is set.
  // Set here rather than in the secret, which stays exactly what Discord's UI
  // hands out.
  const url = new URL(webhookUrl);
  url.searchParams.set("with_components", "true");

  // No Content-Type header: fetch sets it, with the multipart boundary.
  const res = await doFetch(url, { method: "POST", body: form });

  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(`Discord webhook failed: ${res.status} ${detail}`);
  }
}
