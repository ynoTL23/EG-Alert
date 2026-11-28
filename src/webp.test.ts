import assert from "node:assert/strict";
import test from "node:test";
import { dateRange } from "./collage.js";
import { buildImage } from "./webp.js";
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

// What a transcoder returns when the source has transparency: the bitstream
// sits behind a VP8X header and an ALPH chunk rather than at byte 12.
const extended = webp([
  chunk("VP8X", new Uint8Array(10)),
  chunk("ALPH", new Uint8Array(16).fill(0xbb)),
  chunk("VP8 ", new Uint8Array(60).fill(0xcc)),
]);

/** Stands in for Epic's CDN: any source image, always 200. */
const epicFetch = (() =>
  Promise.resolve(
    new Response("jpeg bytes", { status: 200 }),
  )) as unknown as typeof fetch;

/**
 * Stands in for the IMAGES binding: hands out `tiles`, in call order, for every
 * WebP output. PNG outputs (the headline measurement and the round-trips
 * between passes) are blanks.
 */
function imagesReturning(tiles: Uint8Array[]): ImagesBinding {
  let i = 0;
  const transformer = {
    transform: () => transformer,
    draw: () => transformer,
    output: ({ format }: { format: string }) => {
      if (format === "image/png") {
        return Promise.resolve({ image: () => new Blob([]).stream() });
      }
      const tile = tiles[i++];
      return Promise.resolve({ response: () => new Response(tile) });
    },
  };
  return {
    input: () => transformer,
    text: () => transformer,
    info: () =>
      Promise.resolve({ format: "image/png", width: 300, height: 80 }),
  } as unknown as ImagesBinding;
}

const failingTransformer = {
  transform() {
    return this;
  },
  draw() {
    return this;
  },
  output: () => Promise.reject(new Error("9422: free tier exhausted")),
};
const failingImages = {
  input: () => failingTransformer,
  text: () => failingTransformer,
} as unknown as ImagesBinding;

function game(
  title: string,
  imageUrl: string | null = `https://e/${title}.png`,
): FreeGame {
  return {
    title,
    url: "",
    offer: null,
    imageUrl,
    startDate: "2026-11-26T16:00:00.000Z",
    endDate: "2026-12-03T16:00:00.000Z",
    price: 1999,
  };
}

const six = ["A", "B", "C", "D", "E", "F"].map((t) => game(t));

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

void test("extended-format frames keep their real bitstream", async () => {
  const out = await buildImage(
    six,
    imagesReturning([simple, extended, simple, simple, simple, simple]),
    epicFetch,
  );
  assert.ok(out, "expected a slideshow");

  const found = chunksOf(out);
  const frames = found.filter((c) => c.fourcc === "ANMF");
  assert.equal(frames.length, 6);

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

void test("five games or fewer make one still collage", async () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const out = await buildImage(
      six.slice(0, count),
      imagesReturning([simple]),
      epicFetch,
    );
    // The binding's WebP is attached as-is: no animation container around it.
    assert.deepEqual(out, simple, `${count} games`);
  }
});

void test("games without art are left out of the image", async () => {
  const out = await buildImage(
    [game("A", null), game("B", null)],
    imagesReturning([simple]),
    epicFetch,
  );
  assert.equal(out, null);
});

void test("a failed transform falls back to no image", async () => {
  assert.equal(
    await buildImage(six.slice(0, 2), failingImages, epicFetch),
    null,
  );
  assert.equal(await buildImage(six, failingImages, epicFetch), null);
});

void test("the date range runs from the earliest start to the earliest end", () => {
  const late = { ...game("B"), endDate: "2026-12-10T16:00:00.000Z" };
  assert.equal(dateRange([game("A"), late]), "NOV 26 – DEC 3");
  assert.equal(dateRange([{ ...game("A"), startDate: null }]), null);
});
