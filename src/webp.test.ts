import assert from "node:assert/strict";
import test from "node:test";
import { buildSlideshow } from "./webp.js";
import type { FreeGame } from "./types.js";

/** Minimal RIFF chunk: fourcc, little-endian size, payload, even-length pad. */
function chunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  out.set(new TextEncoder().encode(fourcc), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function webp(chunks: Uint8Array[]): Uint8Array {
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const file = new Uint8Array(12 + body);
  file.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(file.buffer).setUint32(4, 4 + body, true);
  file.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const c of chunks) {
    file.set(c, offset);
    offset += c.length;
  }
  return file;
}

const simple = webp([chunk("VP8 ", new Uint8Array(40).fill(0xaa))]);

// What wsrv returns when the source has transparency: the bitstream sits behind
// a VP8X header and an ALPH chunk rather than at byte 12.
const extended = webp([
  chunk("VP8X", new Uint8Array(10)),
  chunk("ALPH", new Uint8Array(16).fill(0xbb)),
  chunk("VP8 ", new Uint8Array(60).fill(0xcc)),
]);

function fetchReturning(tiles: Uint8Array[]): typeof fetch {
  let i = 0;
  return (() =>
    Promise.resolve(
      new Response(tiles[i++], { status: 200 }),
    )) as unknown as typeof fetch;
}

const games: FreeGame[] = [
  {
    title: "A",
    url: "",
    offer: null,
    imageUrl: "https://e/a.png",
    endDate: null,
  },
  {
    title: "B",
    url: "",
    offer: null,
    imageUrl: "https://e/b.png",
    endDate: null,
  },
];

/** Walks the top-level chunks of a RIFF container. */
function chunksOf(file: Uint8Array): Array<{ fourcc: string; size: number }> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const decoder = new TextDecoder();
  const found: Array<{ fourcc: string; size: number }> = [];
  let offset = 12;
  while (offset + 8 <= file.length) {
    const fourcc = decoder.decode(file.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    found.push({ fourcc, size });
    // Descend into frames; their payload holds the bitstream chunks.
    offset += fourcc === "ANMF" ? 8 + 16 : 8 + size + (size % 2);
  }
  return found;
}

void test("extended-format tiles keep their real bitstream", async () => {
  const out = await buildSlideshow(games, fetchReturning([simple, extended]));
  assert.ok(out, "expected a slideshow");

  const found = chunksOf(out);
  const frames = found.filter((c) => c.fourcc === "ANMF");
  assert.equal(frames.length, 2);

  // The regression: frame 1 embedded the 10-byte VP8X header as if it were
  // pixels, leaving an ANMF far too small to hold an image.
  assert.ok(frames[1] !== undefined);
  assert.ok(
    frames[1].size > 60,
    `frame 1 payload was ${frames[1].size} bytes; the bitstream was dropped`,
  );

  // Alpha must survive, and the canvas must advertise it.
  assert.ok(found.some((c) => c.fourcc === "ALPH"));
  const vp8x = found.find((c) => c.fourcc === "VP8X");
  assert.ok(vp8x !== undefined);
  // VP8X payload starts at 20: RIFF header (12) + its own fourcc and size (8).
  const flags = out.at(20);
  assert.ok(flags !== undefined);
  assert.equal(flags & 0x10, 0x10, "VP8X alpha flag not set");
});

void test("a single game produces no animation", async () => {
  const out = await buildSlideshow(games.slice(0, 1), fetchReturning([simple]));
  assert.equal(out, null);
});
