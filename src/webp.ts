import {
  buildCollage,
  buildFrames,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  MAX_COLLAGE_GAMES,
  type PicturedGame,
} from "./collage.js";
import type { FreeGame } from "./types.js";

/**
 * Builds the WebP shown in the Discord embed: one collage for up to five games,
 * or, for six or more, an animation with one frame per game, looping.
 *
 * The Worker never decodes a pixel. Epic's CDN resizes, the Cloudflare Images
 * binding draws every picture (collage.ts), and this module only splices the
 * resulting byte ranges into one RIFF container. That matters: decoding a JPEG
 * costs 100-300ms, and a Worker on the free plan gets 10ms of CPU per cron
 * invocation. The binding is a call out of the isolate, like `fetch()`, so the
 * pixel work happens elsewhere and is what keeps this affordable.
 *
 * Tiles used to come from wsrv.nl, which began answering every request from the
 * deployed Worker with 403 on 2026-11-27 while serving the same URLs to anyone
 * else. A public proxy fronted by Cloudflare can block Worker traffic at will.
 */

/** How long each game's full-size frame is displayed. */
const FRAME_DELAY_MS = 1500;

/** WebP stores canvas/offset fields as 24-bit little-endian. */
function uint24(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
  ]);
}

/**
 * Pulls the compressed bitstream out of a WebP and re-wraps it as chunks we can
 * drop inside an ANMF frame. The pixel data is copied verbatim — this is a byte
 * move, not a re-encode.
 *
 * The bitstream is not at a fixed offset. A tile whose source has transparency
 * comes back extended-format — `VP8X`, then `ALPH`, then `VP8 ` — so anything
 * that assumes the simple-format layout reads the container header as pixels and
 * produces a frame no decoder will render. Walk the chunks instead, and keep
 * `ALPH` with the frame it belongs to: an ANMF holding `VP8 ` without its alpha
 * loses transparency.
 */
function bitstreamChunk(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const decoder = new TextDecoder();
  const parts: Uint8Array[] = [];

  let offset = 12;
  while (offset + 8 <= file.length) {
    const fourcc = decoder.decode(file.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    // RIFF chunks are padded to an even length.
    const stride = 8 + size + (size % 2);

    if (fourcc === "ALPH" || fourcc === "VP8 " || fourcc === "VP8L") {
      parts.push(file.subarray(offset, offset + stride));
    }
    offset += stride;
  }

  if (parts.length === 0) {
    throw new Error("Tile contained no WebP bitstream chunk");
  }

  const total = parts.reduce((n, part) => n + part.length, 0);
  const chunk = new Uint8Array(total);
  let written = 0;
  for (const part of parts) {
    chunk.set(part, written);
    written += part.length;
  }
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
  hasAlpha: boolean,
): Uint8Array {
  const vp8x = new Uint8Array(18);
  vp8x.set(new TextEncoder().encode("VP8X"), 0);
  new DataView(vp8x.buffer).setUint32(4, 10, true);
  // Animation flag, plus the alpha flag when any frame carries an ALPH chunk —
  // without it decoders render the transparency as opaque garbage.
  vp8x[8] = 0x02 | (hasAlpha ? 0x10 : 0x00);
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

/** The splice trusts the container, so check it is one: a WebP always starts RIFF....WEBP. */
function assertWebp(bytes: Uint8Array): Uint8Array {
  const header = new TextDecoder().decode(bytes.subarray(0, 12));
  if (!header.startsWith("RIFF") || !header.endsWith("WEBP")) {
    throw new Error("The Images binding returned something that is not a WebP");
  }
  return bytes;
}

/**
 * One frame per game, looping.
 *
 * Viewers with autoplay disabled — a client-side accessibility setting the API
 * cannot override — see frame 0 and nothing else, so every frame is a complete
 * picture with its own headline and price rather than part of a composition.
 */
async function buildSlideshow(
  games: readonly PicturedGame[],
  images: ImagesBinding,
  doFetch: typeof fetch,
): Promise<Uint8Array> {
  const tiles = await buildFrames(games, images, doFetch);
  const bitstreams = tiles.map((tile) => bitstreamChunk(assertWebp(tile)));
  const frames = bitstreams.map((bitstream) =>
    animationFrame(
      bitstream,
      { x: 0, y: 0, w: FRAME_WIDTH, h: FRAME_HEIGHT },
      FRAME_DELAY_MS,
    ),
  );

  const hasAlpha = bitstreams.some(
    (bitstream) =>
      new TextDecoder().decode(bitstream.subarray(0, 4)) === "ALPH",
  );

  return container(FRAME_WIDTH, FRAME_HEIGHT, frames, hasAlpha);
}

/**
 * The image attached to the embed: a still collage for one to five games, an
 * animation for six or more. Games without key art are left out of it.
 *
 * Returns `null` rather than throwing when the image cannot be built: a missing
 * image is not a reason to skip the week's post.
 *
 * `images` is the Worker's `IMAGES` binding. `doFetch` defaults to the global,
 * matching `fetchFreeGames`/`sendToDiscord`.
 */
export async function buildImage(
  games: readonly FreeGame[],
  images: ImagesBinding,
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  const pictured = games.filter(
    (game): game is PicturedGame => game.imageUrl !== null,
  );
  if (pictured.length === 0) return null;

  try {
    // Throws an ImagesError (e.g. 9422 once the free tier's 5,000 monthly
    // transformations are spent), which the catch turns into "no image".
    return pictured.length <= MAX_COLLAGE_GAMES
      ? await buildCollage(pictured, images, doFetch)
      : await buildSlideshow(pictured, images, doFetch);
  } catch (err) {
    // If Epic's CDN or the Images binding is having a bad Thursday the post
    // still goes out, with Epic's own picture of the first game instead. The
    // message is logged on its own because Workers Logs recorded only the
    // stack on 2026-11-27, which hid the 403 that caused it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Image build failed; posting without it: ${message}`, err);
    return null;
  }
}
