import { NodeBasisEncoder } from "ktx2-encoder";
import type { RgbaImage } from "./png.js";

/** The Basis Universal setters this module calls; the pinned wasm build exposes each of them. */
interface BasisEncoder {
  setStatusOutput(enabled: boolean): void;
  setDebug(enabled: boolean): void;
  setCreateKTX2File(enabled: boolean): void;
  setTexType(type: number): void;
  setUASTC(enabled: boolean): void;
  setMipGen(enabled: boolean): void;
  setYFlip(enabled: boolean): void;
  setForceAlpha(enabled: boolean): void;
  setPerceptual(enabled: boolean): void;
  setKTX2AndBasisSRGBTransferFunc(enabled: boolean): void;
  setKTX2UASTCSupercompression(enabled: boolean): void;
  setSliceSourceImage(
    slice: number,
    rgba: Uint8Array,
    width: number,
    height: number,
    type: number,
  ): boolean;
  encode(output: Uint8Array): number;
  delete(): void;
}

// The pinned ktx2-encoder package bundles a single-threaded Basis Universal wasm build and loads it
// from its own install, never the network. One instance serves every encode in this process.
const basis = (await new NodeBasisEncoder().init()) as unknown as {
  BasisEncoder: new () => BasisEncoder;
};

/**
 * KTX2 holding Basis Universal UASTC LDR 4×4 with Zstandard supercompression: one file per page that
 * a client transcodes to ASTC 4×4, BC7, ETC2 or BC3, whichever its GPU samples. Every texture is a
 * single level with alpha, stored top row first. Fixed settings and the single-threaded encoder make
 * the bytes a function of the image and encoding alone.
 */
export function encodeKtx2Uastc(image: RgbaImage, encoding: "srgb" | "linear"): Uint8Array {
  const encoder = new basis.BasisEncoder();
  try {
    encoder.setStatusOutput(false);
    encoder.setDebug(false);
    encoder.setCreateKTX2File(true);
    encoder.setTexType(0); // cBASISTexType2D.
    encoder.setUASTC(true);
    encoder.setMipGen(false);
    encoder.setYFlip(false);
    encoder.setForceAlpha(true);
    encoder.setPerceptual(encoding === "srgb");
    encoder.setKTX2AndBasisSRGBTransferFunc(encoding === "srgb");
    encoder.setKTX2UASTCSupercompression(true);
    // Source type 0 is raw RGBA8.
    if (encoder.setSliceSourceImage(0, image.rgba, image.width, image.height, 0) === false)
      throw new Error(`KTX2 source rejected: ${image.width}x${image.height}`);
    // UASTC is 16 bytes per 4×4 block before supercompression; the slack covers headers and the DFD.
    const output = new Uint8Array(
      Math.ceil(image.width / 4) * Math.ceil(image.height / 4) * 32 + 65_536,
    );
    const length = encoder.encode(output);
    if (length === 0) throw new Error(`KTX2 encode failed: ${image.width}x${image.height}`);
    return output.slice(0, length);
  } finally {
    encoder.delete();
  }
}
