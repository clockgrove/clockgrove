import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major 8-bit RGBA, `width * height * 4` bytes. */
  readonly rgba: Uint8Array;
}

const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Deterministic: 8-bit RGBA, filter 0 on every row, zlib level 9. */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, rgba } = image;
  if (rgba.length !== width * height * 4) throw new Error("rgba length does not match the size");
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Reads non-interlaced 8-bit RGBA PNGs with any scanline filter. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b))
    throw new Error("not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || colour !== 6) throw new Error("transparency: source must be 8-bit RGBA");
      if (interlace !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error("PNG has no IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error("PNG pixel data has the wrong size");
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const a = i >= 4 ? (rgba[y * stride + i - 4] as number) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= 4 ? (rgba[(y - 1) * stride + i - 4] as number) : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`unknown PNG filter ${filter}`);
      rgba[y * stride + i] = (x + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}
