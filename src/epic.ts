const FREE_GAMES_URL =
  "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions";

const STORE_BASE = "https://store.epicgames.com/en-US/p/";

export interface FreeGame {
  title: string;
  url: string;
  imageUrl: string | null;
  endDate: string | null;
}

interface PromotionalOffer {
  startDate: string | null;
  endDate: string | null;
  discountSetting?: { discountPercentage?: number | null } | null;
}

interface Element {
  title?: string | null;
  productSlug?: string | null;
  urlSlug?: string | null;
  offerType?: string | null;
  keyImages?: Array<{ type?: string | null; url?: string | null }> | null;
  price?: {
    totalPrice?: { discountPrice?: number | null } | null;
  } | null;
  catalogNs?: { mappings?: Array<{ pageSlug?: string | null }> | null } | null;
  offerMappings?: Array<{ pageSlug?: string | null }> | null;
  promotions?: {
    promotionalOffers?: Array<{ promotionalOffers?: PromotionalOffer[] | null }> | null;
  } | null;
}

/**
 * Epic's `productSlug` is null for a lot of offers, and `urlSlug` is
 * sometimes a raw hex id ("a6dcabac79154e218bd3c7d4a8cad8a7") that 404s on
 * the storefront. The mapping pageSlugs are the reliable source, so prefer
 * those and only fall back to the slug fields.
 */
function resolveSlug(el: Element): string | null {
  const mapped =
    el.catalogNs?.mappings?.[0]?.pageSlug ?? el.offerMappings?.[0]?.pageSlug;
  if (mapped) return mapped;

  // A 32-char hex urlSlug is an internal id, not a storefront path.
  const slug = el.productSlug ?? el.urlSlug ?? null;
  if (!slug || /^[0-9a-f]{32}$/i.test(slug)) return null;
  return slug.replace(/\/home$/, "");
}

/**
 * An offer is free right now when it has a live promotional window AND the
 * price actually resolves to zero. `discountPercentage` here is the
 * *resulting* percentage (0 = free, 50 = half price), which reads backwards,
 * so the price check is what we lean on.
 */
function isFreeNow(el: Element, now: Date): boolean {
  if (el.price?.totalPrice?.discountPrice !== 0) return false;

  const offers = el.promotions?.promotionalOffers ?? [];
  return offers.some((group) =>
    (group?.promotionalOffers ?? []).some((offer) => {
      if (!offer?.startDate || !offer?.endDate) return false;
      const start = new Date(offer.startDate).getTime();
      const end = new Date(offer.endDate).getTime();
      return now.getTime() >= start && now.getTime() < end;
    }),
  );
}

function activeEndDate(el: Element): string | null {
  for (const group of el.promotions?.promotionalOffers ?? []) {
    for (const offer of group?.promotionalOffers ?? []) {
      if (offer?.endDate) return offer.endDate;
    }
  }
  return null;
}

function pickImage(el: Element): string | null {
  const images = el.keyImages ?? [];
  const preferred = ["OfferImageWide", "DieselStoreFrontWide", "Thumbnail"];
  for (const type of preferred) {
    const hit = images.find((img) => img?.type === type && img.url);
    if (hit?.url) return hit.url;
  }
  return images.find((img) => img?.url)?.url ?? null;
}

export async function fetchFreeGames(now = new Date()): Promise<FreeGame[]> {
  const res = await fetch(
    `${FREE_GAMES_URL}?locale=en-US&country=US&allowCountries=US`,
    { headers: { "User-Agent": "epicgamesnotif (Cloudflare Worker)" } },
  );

  if (!res.ok) {
    throw new Error(`Epic API returned ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as {
    data?: { Catalog?: { searchStore?: { elements?: Element[] } } };
  };

  const elements = body.data?.Catalog?.searchStore?.elements ?? [];

  const games: FreeGame[] = [];
  const seen = new Set<string>();

  for (const el of elements) {
    if (!el?.title || !isFreeNow(el, now)) continue;

    // Epic lists add-ons and editions alongside the base giveaway; the
    // base game is the one people actually want linked.
    if (el.offerType === "ADD_ON") continue;

    const slug = resolveSlug(el);
    if (seen.has(el.title)) continue;
    seen.add(el.title);

    games.push({
      title: el.title,
      url: slug ? `${STORE_BASE}${slug}` : "https://store.epicgames.com/en-US/free-games",
      imageUrl: pickImage(el),
      endDate: activeEndDate(el),
    });
  }

  return games;
}
