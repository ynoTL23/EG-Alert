import { formatPrice } from "./constants.js";
import type { FreeGame } from "./types.js";

/**
 * Draws the embed's pictures inside the Cloudflare Images binding: a collage
 * of up to five games, or one slideshow frame per game, each with the
 * "FREE THIS WEEK" headline, the week's dates and every game's usual price.
 *
 * Nothing here decodes a pixel. Every tile, label and border is an instruction
 * sent to the binding (`draw()`, `text()`, `transform()`), so the work happens
 * outside the Worker's 10ms CPU budget. See "Images binding" in AGENTS.md for
 * the limits that shape this file.
 */

/** A game that has key art to draw. */
export type PicturedGame = FreeGame & { imageUrl: string };

/**
 * Saira Condensed, pinned: the date chip is placed from the headline chip's
 * measured width, and an unpinned font could change its metrics underneath.
 * The binding takes fonts only as an https URL — no system fonts, no family
 * names, and `data:` URLs are rejected — so this is the one dependency fetched
 * outside Epic and Cloudflare.
 */
function fontUrl(weight: 700 | 800): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/saira-condensed@5.3.0/latin-${weight}-normal.ttf`;
}

const HEADLINE = "FREE THIS WEEK";
const INK = "#000000";
const PAPER = "#ffffff";
const EPIC_BLUE = "#0078f2";

/**
 * The collage is 1600x900: Discord shows embed images in a 400x225 box on
 * desktop, so every layout is 16:9 and every label lands at 13px or more after
 * the 4x shrink. Clicking the image opens it full size. The canvas is drawn at
 * 1584x884 and an 8px black frame brings it to 1600x900.
 */
const CANVAS_W = 1584;
const CANVAS_H = 884;
const FRAME = 8;
/** Black gap between rectangular tiles. */
const GAP = 8;

/** Slideshow frames are 2x the display box, so labels shrink by half. */
export const FRAME_WIDTH = 800;
export const FRAME_HEIGHT = 450;

/** Five games or fewer share one picture; six or more become a slideshow. */
export const MAX_COLLAGE_GAMES = 5;

interface Scale {
  chip: number;
  chipPad: number;
  price: number;
  pricePad: number;
  /** Black outline on every label, so a blue or white chip still has an edge on blue or white art. */
  outline: number;
  inset: number;
}
const COLLAGE_SCALE: Scale = {
  chip: 67,
  chipPad: 16,
  price: 63,
  pricePad: 12,
  outline: 6,
  inset: 24,
};
const FRAME_SCALE: Scale = {
  chip: 34,
  chipPad: 8,
  price: 32,
  pricePad: 6,
  outline: 3,
  inset: 12,
};

/**
 * One request to the binding accepts at most 10 entries — every transform and
 * every draw in the chain counts — and fails with `9432: Bad request: 10
 * "transforms" maximum` past that. `compose()` splits the chain into passes.
 */
const MAX_ENTRIES = 10;

/**
 * One step applied to the canvas, and how many of the 10 entries it uses.
 * `apply` builds its handles when called: a handle can be drawn only once
 * (`9525: ImageTransformer consumed`).
 */
interface Layer {
  cost: number;
  apply: (canvas: ImageTransformer) => ImageTransformer;
}

/**
 * Runs the layers in as few requests as the entry limit allows. Between
 * passes the canvas round-trips as PNG through the binding, never through the
 * Worker's own CPU.
 *
 * Callers must put every image draw before every text draw. Within one
 * request the binding pairs an image drawn after a text with the wrong
 * transforms (it numbers text and image draws separately), so that order is
 * what keeps each pass correct.
 */
async function compose(
  images: ImagesBinding,
  base: ImageTransformer,
  layers: readonly Layer[],
): Promise<ImageTransformer> {
  let canvas = base;
  let used = 1;
  for (const layer of layers) {
    if (used + layer.cost > MAX_ENTRIES) {
      const pass = await canvas.output({ format: "image/png" });
      canvas = images.input(pass.image());
      used = 0;
    }
    canvas = layer.apply(canvas);
    used += layer.cost;
  }
  return canvas;
}

/**
 * Epic's CDN only resizes with `resize=1`; without it the request returns the
 * multi-megabyte original. 1600 wide covers every tile the layouts cut, so
 * the binding only ever scales down.
 */
async function fetchArt(
  url: string,
  doFetch: typeof fetch,
): Promise<ReadableStream<Uint8Array>> {
  const res = await doFetch(`${url}?resize=1&w=1600`);
  if (!res.ok || !res.body) {
    throw new Error(`Art fetch failed: ${res.status} ${res.statusText}`);
  }
  // workers-types declares `body` as `ReadableStream<any>`; the Fetch spec says
  // its chunks are always Uint8Array.
  return res.body as ReadableStream<Uint8Array>;
}

function bytes(base64: string): ReadableStream<Uint8Array> {
  const blob = new Blob([
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
  ]);
  // workers-types declares Blob.stream() as `ReadableStream<any>`; its chunks
  // are Uint8Array.
  return blob.stream() as ReadableStream<Uint8Array>;
}

/** A black 1x1 PNG, stretched into the blank canvas the tiles are drawn on. */
const BLACK_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYGAAAAAEAAGjChXjAAAAAElFTkSuQmCC";

// ---- Labels ----------------------------------------------------------------

interface LabelStyle {
  weight: 700 | 800;
  size: number;
  color: string;
  background: string;
  pad: number;
  outline: number;
}

/** Text on a solid box with a black outline: two transforms on one text handle. */
function label(
  images: ImagesBinding,
  text: string,
  style: LabelStyle,
): ImageTransformer {
  return images
    .text(text, {
      font: { url: fontUrl(style.weight) },
      size: style.size,
      color: style.color,
    })
    .transform({
      background: style.background,
      border: { color: style.background, width: style.pad },
    })
    .transform({ border: { color: INK, width: style.outline } });
}

function labelLayer(
  images: ImagesBinding,
  text: string,
  style: LabelStyle,
  at: ImageDrawOptions,
): Layer {
  return {
    cost: 3,
    apply: (canvas) => canvas.draw(label(images, text, style), at),
  };
}

function headlineStyle(scale: Scale): LabelStyle {
  return {
    weight: 800,
    size: scale.chip,
    color: PAPER,
    background: EPIC_BLUE,
    pad: scale.chipPad,
    outline: scale.outline,
  };
}

/**
 * Width of the headline chip, so the date chip can join it. Measured rather
 * than hard-coded so a font or size change cannot open a gap; the identical
 * request each week counts once a month against the transformation quota.
 */
async function headlineWidth(
  images: ImagesBinding,
  scale: Scale,
): Promise<number> {
  const chip = await label(images, HEADLINE, headlineStyle(scale)).output({
    format: "image/png",
  });
  const info = await images.info(chip.image());
  // Only an SVG reports no size, and this was requested as PNG.
  if (!("width" in info))
    throw new Error("Headline chip came back without a size");
  return info.width;
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function earliest(dates: readonly (string | null)[]): Date | null {
  const times = dates.map((d) => Date.parse(d ?? "")).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)) : null;
}

/**
 * "NOV 26 – DEC 3": the earliest start to the earliest end, so the range never
 * promises a game is free longer than it is. UTC dates are Eastern dates here:
 * Epic's windows turn at 11:00 Eastern, which is 15:00 or 16:00 UTC.
 *
 * Hand-rolled because `Intl.DateTimeFormat` loads locale data, the same cost
 * that rules out `Intl.NumberFormat` (see formatPrice).
 */
export function dateRange(games: readonly FreeGame[]): string | null {
  const start = earliest(games.map((g) => g.startDate));
  const end = earliest(games.map((g) => g.endDate));
  if (!start || !end) return null;
  const day = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${day(start)} – ${day(end)}`;
}

/** The blue headline chip, joined on its right by the white date chip. */
function headlineLayers(
  images: ImagesBinding,
  scale: Scale,
  width: number,
  dates: string | null,
): Layer[] {
  const head = headlineStyle(scale);
  const layers = [
    labelLayer(images, HEADLINE, head, { left: scale.inset, top: scale.inset }),
  ];
  if (dates) {
    // Overlap by one outline, so the seam is one outline thick rather than two.
    layers.push(
      labelLayer(
        images,
        dates,
        { ...head, weight: 700, color: INK, background: PAPER },
        { left: scale.inset + width - scale.outline, top: scale.inset },
      ),
    );
  }
  return layers;
}

function priceStyle(scale: Scale): LabelStyle {
  return {
    weight: 700,
    size: scale.price,
    color: INK,
    background: PAPER,
    pad: scale.pricePad,
    outline: scale.outline,
  };
}

// ---- Collage -----------------------------------------------------------------

type Tile =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "slice"; x: number };

/**
 * Five games are cut into slices leaning "/". Each slice is the art masked to
 * a parallelogram: 456x884, its top edge shifted 124px right of its bottom,
 * antialiased. Slices sit `SLICE_PITCH` apart and overlap so the gap between
 * neighbours is 10px; the outer two run off the canvas.
 */
const SLICE_W = 456;
const SLICE_SLANT = 124;
const SLICE_PITCH = 341.6;
const SLICE_GAP = 10;
const SLICE_MASK =
  "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";

function layout(count: number): Tile[] {
  const rect = (x: number, y: number, w: number, h: number): Tile => ({
    kind: "rect",
    x,
    y,
    w,
    h,
  });
  const halfW = (CANVAS_W - GAP) / 2;
  const halfH = (CANVAS_H - GAP) / 2;
  switch (count) {
    case 1:
      return [rect(0, 0, CANVAS_W, CANVAS_H)];
    case 2:
      return [
        rect(0, 0, halfW, CANVAS_H),
        rect(halfW + GAP, 0, halfW, CANVAS_H),
      ];
    case 3: {
      // Two 16:9 tiles stacked on the right; the large tile takes the rest.
      const sideW = Math.round((halfH * 16) / 9);
      const mainW = CANVAS_W - GAP - sideW;
      return [
        rect(0, 0, mainW, CANVAS_H),
        rect(mainW + GAP, 0, sideW, halfH),
        rect(mainW + GAP, halfH + GAP, sideW, halfH),
      ];
    }
    case 4:
      return [0, 1, 2, 3].map((i) =>
        rect(
          (i % 2) * (halfW + GAP),
          Math.floor(i / 2) * (halfH + GAP),
          halfW,
          halfH,
        ),
      );
    case 5:
      return [0, 1, 2, 3, 4].map((i) => ({
        kind: "slice",
        x: Math.round(i * SLICE_PITCH - SLICE_SLANT + SLICE_GAP / 2),
      }));
    default:
      throw new Error(`No collage layout for ${count} games`);
  }
}

function tileLayer(
  images: ImagesBinding,
  tile: Tile,
  art: ReadableStream<Uint8Array>,
): Layer {
  // gravity "auto" keeps the subject when a tile crops the 16:9 art.
  switch (tile.kind) {
    case "rect":
      return {
        cost: 2,
        apply: (canvas) =>
          canvas.draw(
            images.input(art).transform({
              width: tile.w,
              height: tile.h,
              fit: "cover",
              gravity: "auto",
            }),
            { left: tile.x, top: tile.y },
          ),
      };
    case "slice":
      return {
        cost: 3,
        apply: (canvas) =>
          canvas.draw(
            images.input(bytes(SLICE_MASK)).draw(
              images.input(art).transform({
                width: SLICE_W,
                height: CANVAS_H,
                fit: "cover",
                gravity: "auto",
              }),
              { composite: "in" },
            ),
            { left: tile.x, top: 0 },
          ),
      };
    default: {
      const unknown: never = tile;
      throw new Error(`Unknown tile ${JSON.stringify(unknown)}`);
    }
  }
}

/** Bottom-left of a rectangle; bottom-right of a slice, whose left edge is cut away at the bottom. */
function priceAt(tile: Tile, inset: number): ImageDrawOptions {
  switch (tile.kind) {
    case "rect":
      return {
        left: tile.x + inset,
        bottom: CANVAS_H - (tile.y + tile.h) + inset,
      };
    case "slice": {
      const right = CANVAS_W - (tile.x + SLICE_W - SLICE_SLANT) + inset;
      return { right: Math.max(right, inset), bottom: inset };
    }
    default: {
      const unknown: never = tile;
      throw new Error(`Unknown tile ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * One 1600x900 WebP for one to five games: side by side, a large tile with two
 * stacked, a 2x2 grid, or five slanted slices. 2-4 requests to the binding,
 * plus one for the headline's width.
 */
export async function buildCollage(
  games: readonly PicturedGame[],
  images: ImagesBinding,
  doFetch: typeof fetch,
): Promise<Uint8Array> {
  const tiles = layout(games.length);
  const [art, width] = await Promise.all([
    Promise.all(games.map((g) => fetchArt(g.imageUrl, doFetch))),
    headlineWidth(images, COLLAGE_SCALE),
  ]);
  const price = priceStyle(COLLAGE_SCALE);

  // Tiles first: no image may be drawn after a label (see compose).
  const layers: Layer[] = tiles.flatMap((tile, i) => {
    const body = art[i];
    return body ? [tileLayer(images, tile, body)] : [];
  });
  layers.push(
    ...headlineLayers(images, COLLAGE_SCALE, width, dateRange(games)),
  );
  games.forEach((game, i) => {
    const tile = tiles[i];
    if (tile && game.price) {
      layers.push(
        labelLayer(
          images,
          formatPrice(game.price),
          price,
          priceAt(tile, COLLAGE_SCALE.inset),
        ),
      );
    }
  });
  layers.push({
    cost: 1,
    apply: (canvas) =>
      canvas.transform({ border: { color: INK, width: FRAME } }),
  });

  const blank = images
    .input(bytes(BLACK_PIXEL))
    .transform({ width: CANVAS_W, height: CANVAS_H, fit: "squeeze" });
  const canvas = await compose(images, blank, layers);
  const out = await canvas.output({ format: "image/webp", quality: 82 });
  return new Uint8Array(await out.response().arrayBuffer());
}

// ---- Slideshow frames --------------------------------------------------------

/**
 * One complete 800x450 WebP per game: its art, the headline and its price.
 * Every frame stands alone because viewers with autoplay off only see frame 0.
 * Art (1) + two chips (3 each) + price (3) is exactly the 10-entry limit, so
 * each frame is one request; any added layer makes it two.
 */
export async function buildFrames(
  games: readonly PicturedGame[],
  images: ImagesBinding,
  doFetch: typeof fetch,
): Promise<Uint8Array[]> {
  const width = await headlineWidth(images, FRAME_SCALE);
  const dates = dateRange(games);
  const price = priceStyle(FRAME_SCALE);

  return Promise.all(
    games.map(async (game) => {
      const art = images
        .input(await fetchArt(game.imageUrl, doFetch))
        .transform({ width: FRAME_WIDTH, height: FRAME_HEIGHT, fit: "cover" });
      const layers = headlineLayers(images, FRAME_SCALE, width, dates);
      if (game.price) {
        const inset = FRAME_SCALE.inset;
        layers.push(
          labelLayer(images, formatPrice(game.price), price, {
            left: inset,
            bottom: inset,
          }),
        );
      }
      const canvas = await compose(images, art, layers);
      const out = await canvas.output({ format: "image/webp", quality: 80 });
      return new Uint8Array(await out.response().arrayBuffer());
    }),
  );
}
