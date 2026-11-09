import type { RgbaImage } from "./png.js";

/** DDS/DXT5 (BC3): 4×4 texel blocks, 16 bytes each, per Microsoft's DDS/BC3 specification. */
export function encodeBc3Dds(image: RgbaImage): Uint8Array {
  const columns = Math.ceil(image.width / 4);
  const rows = Math.ceil(image.height / 4);
  const out = new Uint8Array(128 + columns * rows * 16);
  const view = new DataView(out.buffer);
  out.set([0x44, 0x44, 0x53, 0x20]);
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x81007, true); // CAPS, HEIGHT, WIDTH, PIXELFORMAT, LINEARSIZE.
  view.setUint32(12, image.height, true);
  view.setUint32(16, image.width, true);
  view.setUint32(20, out.length - 128, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, 4, true); // DDPF_FOURCC.
  out.set([0x44, 0x58, 0x54, 0x35], 84);
  view.setUint32(108, 0x1000, true); // DDSCAPS_TEXTURE.
  const rgb565 = (rgb: readonly number[]): number =>
    (((rgb[0] as number) >> 3) << 11) |
    (((rgb[1] as number) >> 2) << 5) |
    ((rgb[2] as number) >> 3);
  const expand = (n: number): number[] => [
    Math.round((((n >> 11) & 31) * 255) / 31),
    Math.round((((n >> 5) & 63) * 255) / 63),
    Math.round(((n & 31) * 255) / 31),
  ];
  for (let by = 0; by < rows; by++)
    for (let bx = 0; bx < columns; bx++) {
      const pixels: number[][] = [];
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          // Clamp partial blocks to the last source texel, without resizing the actual texture.
          const i =
            (Math.min(by * 4 + y, image.height - 1) * image.width +
              Math.min(bx * 4 + x, image.width - 1)) *
            4;
          pixels.push(Array.from(image.rgba.subarray(i, i + 4)));
        }
      const at = 128 + (by * columns + bx) * 16;
      const alpha0 = Math.max(...pixels.map((p) => p[3] as number));
      const alpha1 = Math.min(...pixels.map((p) => p[3] as number));
      out[at] = alpha0;
      out[at + 1] = alpha1;
      const alpha = [alpha0, alpha1];
      if (alpha0 > alpha1)
        for (let i = 1; i <= 6; i++) alpha.push(Math.floor(((7 - i) * alpha0 + i * alpha1) / 7));
      else {
        for (let i = 1; i <= 4; i++) alpha.push(Math.floor(((5 - i) * alpha0 + i * alpha1) / 5));
        alpha.push(0, 255);
      }
      let alphaBits = 0n;
      const endpoints = pixels.map(rgb565);
      const c0 = Math.max(...endpoints),
        c1 = Math.min(...endpoints);
      view.setUint16(at + 8, c0, true);
      view.setUint16(at + 10, c1, true);
      const a = expand(c0),
        b = expand(c1);
      const palette = [
        a,
        b,
        a.map((v, i) => Math.floor((2 * v + (b[i] as number)) / 3)),
        a.map((v, i) => Math.floor((v + 2 * (b[i] as number)) / 3)),
      ];
      let colourBits = 0;
      pixels.forEach((p, n) => {
        let bestAlpha = 0,
          bestColour = 0;
        for (let i = 1; i < alpha.length; i++)
          if (
            Math.abs((p[3] as number) - (alpha[i] as number)) <
            Math.abs((p[3] as number) - (alpha[bestAlpha] as number))
          )
            bestAlpha = i;
        const error = (c: readonly number[]) =>
          c.reduce((sum, value, i) => sum + (value - (p[i] as number)) ** 2, 0);
        for (let i = 1; i < palette.length; i++)
          if (error(palette[i] as number[]) < error(palette[bestColour] as number[]))
            bestColour = i;
        alphaBits |= BigInt(bestAlpha) << BigInt(n * 3);
        colourBits |= bestColour << (n * 2);
      });
      for (let i = 0; i < 6; i++) out[at + 2 + i] = Number((alphaBits >> BigInt(i * 8)) & 255n);
      view.setUint32(at + 12, colourBits >>> 0, true);
    }
  return out;
}
