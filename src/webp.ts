import type { FreeGame } from "./types.js";

/**
 * Builds the animated WebP shown in the Discord embed: one frame per free game,
 * looping.
 *
 * The Worker never decodes a pixel. Epic's CDN resizes, wsrv.nl transcodes each
 * tile to WebP, and this module only splices the resulting byte ranges into one
 * RIFF container. That matters: decoding a JPEG costs 100-300ms, and a Worker on
 * the free plan gets 10ms of CPU per cron invocation. `fetch()` time does not
 * count toward that budget, so pushing the pixel work over the network is what
 * keeps this affordable.
 */

/** How long each game's full-size frame is displayed. */
const FRAME_DELAY_MS = 1000;

/** Frames are fetched from wsrv.nl, which transcodes to WebP for us. */
const WSRV = "https://wsrv.nl/";

/**
 * Epic's CDN only resizes when `resize=1` is present. Without it the request
 * falls through to S3 and returns the multi-megabyte original, so it is not
 * optional — it is the difference between a 40KB fetch and a 3MB one.
 */
function epicSized(url: string, width: number): string {
  return `${url}?resize=1&w=${width}`;
}

function tileUrl(source: string, w: number, h: number): string {
  // Request the source at 2x the tile so wsrv is downscaling, never upscaling.
  const src = encodeURIComponent(epicSized(source, w * 2));
  return `${WSRV}?url=${src}&w=${w}&h=${h}&fit=cover&output=webp&q=80`;
}

/** Every frame fills the canvas, sized to Epic's 16:9 key art. */
const FRAME_WIDTH = 800;
const FRAME_HEIGHT = 450;

/** WebP stores canvas/offset fields as 24-bit little-endian. */
function uint24(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
  ]);
}

/**
 * Pulls the compressed bitstream out of a simple-format WebP and re-wraps it as
 * a chunk we can drop inside an ANMF frame. The pixel data is copied verbatim —
 * this is a byte move, not a re-encode.
 */
function bitstreamChunk(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const fourcc = new TextDecoder().decode(file.subarray(12, 16));
  const size = view.getUint32(16, true);
  const payload = file.subarray(20, 20 + size);

  // RIFF chunks are padded to an even length.
  const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
  chunk.set(new TextEncoder().encode(fourcc.padEnd(4)), 0);
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return chunk;
}

/**
 * One animation frame. `durationMs` of 0 means "show the next frame
 * immediately", which is how the grid's tiles are painted into a single visible
 * frame: every tile but the last is instant, so they land in one display tick.
 */
function animationFrame(
  bitstream: Uint8Array,
  cell: { x: number; y: number; w: number; h: number },
  durationMs: number,
): Uint8Array {
  const header = new Uint8Array(24);
  header.set(new TextEncoder().encode("ANMF"), 0);
  new DataView(header.buffer).setUint32(4, 16 + bitstream.length, true);
  // Offsets are stored halved, so they must be even. Sizes are stored minus one.
  header.set(uint24(cell.x >> 1), 8);
  header.set(uint24(cell.y >> 1), 11);
  header.set(uint24(cell.w - 1), 14);
  header.set(uint24(cell.h - 1), 17);
  header.set(uint24(durationMs), 20);
  header[23] = 0; // blend with canvas, do not dispose

  const frame = new Uint8Array(header.length + bitstream.length);
  frame.set(header, 0);
  frame.set(bitstream, header.length);
  return frame;
}

function container(
  width: number,
  height: number,
  frames: Uint8Array[],
): Uint8Array {
  const vp8x = new Uint8Array(18);
  vp8x.set(new TextEncoder().encode("VP8X"), 0);
  new DataView(vp8x.buffer).setUint32(4, 10, true);
  vp8x[8] = 0x02; // animation flag
  vp8x.set(uint24(width - 1), 12);
  vp8x.set(uint24(height - 1), 15);

  const anim = new Uint8Array(14);
  anim.set(new TextEncoder().encode("ANIM"), 0);
  new DataView(anim.buffer).setUint32(4, 6, true);
  new DataView(anim.buffer).setUint32(8, 0, true); // transparent background
  new DataView(anim.buffer).setUint16(12, 0, true); // loop forever

  const bodyLength =
    vp8x.length + anim.length + frames.reduce((n, f) => n + f.length, 0);
  const file = new Uint8Array(12 + bodyLength);
  file.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(file.buffer).setUint32(4, 4 + bodyLength, true);
  file.set(new TextEncoder().encode("WEBP"), 8);

  let offset = 12;
  for (const part of [vp8x, anim, ...frames]) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
}

async function fetchTile(
  url: string,
  doFetch: typeof fetch,
): Promise<Uint8Array> {
  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(`Tile fetch failed: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // wsrv can answer 200 with an error page; a WebP always starts RIFF....WEBP.
  const header = new TextDecoder().decode(bytes.subarray(0, 12));
  if (!header.startsWith("RIFF") || !header.endsWith("WEBP")) {
    throw new Error("Tile fetch returned something that is not a WebP");
  }
  return bytes;
}

/**
 * One frame per game, each the game's full key art, looping.
 *
 * Viewers with autoplay disabled — a client-side accessibility setting the API
 * cannot override — see frame 0 and nothing else, so every frame is a complete
 * picture rather than part of a composition.
 *
 * Returns `null` rather than throwing when the art cannot be built: a missing
 * image is not a reason to skip the week's post.
 *
 * `doFetch` defaults to the global, matching `fetchFreeGames`/`sendToDiscord`.
 */
export async function buildSlideshow(
  games: FreeGame[],
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  const sources = games.map((g) => g.imageUrl).filter((url) => url !== null);
  // Nothing to animate through: one game's art is just a picture, and the embed
  // links Epic's CDN copy of it directly rather than re-hosting a one-frame loop.
  if (sources.length < 2) return null;

  try {
    const images = await Promise.all(
      sources.map((url) =>
        fetchTile(tileUrl(url, FRAME_WIDTH, FRAME_HEIGHT), doFetch),
      ),
    );

    const frames = images.map((image) =>
      animationFrame(
        bitstreamChunk(image),
        { x: 0, y: 0, w: FRAME_WIDTH, h: FRAME_HEIGHT },
        FRAME_DELAY_MS,
      ),
    );

    return container(FRAME_WIDTH, FRAME_HEIGHT, frames);
  } catch (err) {
    // wsrv.nl is a third party. If it is having a bad Thursday the post still
    // goes out, just without the animation.
    console.error("Slideshow build failed; posting without it:", err);
    return null;
  }
}
