// Issue 77's 2D arm: frames cut from the owner's identity sheet (docs/design/reference/stevie-sprite-sheet.png)
// by a plain crop, because Assetforge's sheet import is not available in the sandbox (plan, assumption 5).
// Alpha is keyed from each cell's corner colour; the normal map is derived from a height estimate.

/** The sheet's grid, measured from the file: 1536×1840 pixels, 8 columns × 8 rows of 192×230 cells. */
export const SHEET = { columns: 8, cellWidth: 192, cellHeight: 230, labelRows: 22 } as const;
/** Cut frame height: the cell less the frame-number label at its top. */
export const CUT_HEIGHT = SHEET.cellHeight - SHEET.labelRows;
/** Which sheet frames the arm uses (frame numbers as printed on the sheet). */
export const SHEET_FRAMES = {
  /** Three-quarter front-right, small idle motions. */
  idle: [0, 1, 2, 3, 4, 5],
  /** Side view walking right. */
  walkRight: [6, 7, 8, 9, 10, 11, 12, 13],
  /** Side view walking left. */
  walkLeft: [14, 15, 16, 17, 18, 19, 20, 21],
} as const;
const USED = [...SHEET_FRAMES.idle, ...SHEET_FRAMES.walkRight, ...SHEET_FRAMES.walkLeft];
const ATLAS_COLUMNS = 8;

export interface CutSheet {
  readonly width: number;
  readonly height: number;
  /** RGBA8, top row first: keyed colour with a 1-pixel dark edge, and the derived tangent-space normal. */
  readonly albedo: Uint8ClampedArray;
  readonly normal: Uint8ClampedArray;
  /** Atlas cell (column, row) of a sheet frame number. */
  cell(frame: number): { column: number; row: number };
  readonly columns: number;
  readonly rows: number;
  readonly stepMs: Readonly<Record<string, number>>;
}

async function loadPixels(url: string): Promise<ImageData> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2D canvas context");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Separable box blur of a single-channel float image, `passes` times (≈ a Gaussian dome on alpha). */
function blur(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
  passes: number,
): Float32Array {
  let a = src;
  for (let pass = 0; pass < passes; pass++) {
    const tmp = new Float32Array(a.length);
    const out = new Float32Array(a.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++)
          sum += a[y * w + Math.min(w - 1, Math.max(0, x + k))] ?? 0;
        tmp[y * w + x] = sum / (2 * radius + 1);
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++)
          sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] ?? 0;
        out[y * w + x] = sum / (2 * radius + 1);
      }
    a = out;
  }
  return a;
}

export async function cutSheet(url: string): Promise<CutSheet> {
  const stepMs: Record<string, number> = {};
  let start = performance.now();
  const sheet = await loadPixels(url);
  stepMs.decode = Math.round(performance.now() - start);
  const w = SHEET.cellWidth;
  const h = CUT_HEIGHT;
  const rows = Math.ceil(USED.length / ATLAS_COLUMNS);
  const width = ATLAS_COLUMNS * w;
  const height = rows * h;
  const albedo = new Uint8ClampedArray(width * height * 4);
  const normal = new Uint8ClampedArray(width * height * 4);
  const cells = new Map<number, { column: number; row: number }>();

  start = performance.now();
  const alphas: Float32Array[] = [];
  USED.forEach((frame, i) => {
    const column = i % ATLAS_COLUMNS;
    const row = Math.floor(i / ATLAS_COLUMNS);
    cells.set(frame, { column, row });
    const sx = (frame % SHEET.columns) * SHEET.cellWidth;
    const sy = Math.floor(frame / SHEET.columns) * SHEET.cellHeight + SHEET.labelRows;
    // The key colour: the cell's bottom-right corner, which is always background on this sheet.
    const keyAt = ((sy + h - 2) * sheet.width + sx + w - 2) * 4;
    const key = [sheet.data[keyAt] ?? 0, sheet.data[keyAt + 1] ?? 0, sheet.data[keyAt + 2] ?? 0];
    const alpha = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const from = ((sy + y) * sheet.width + sx + x) * 4;
        const r = sheet.data[from] ?? 0;
        const g = sheet.data[from + 1] ?? 0;
        const b = sheet.data[from + 2] ?? 0;
        const distance = Math.hypot(r - (key[0] ?? 0), g - (key[1] ?? 0), b - (key[2] ?? 0));
        const a = Math.max(0, Math.min(1, (distance - 14) / 26));
        alpha[y * w + x] = a;
        const to = ((row * h + y) * width + column * w + x) * 4;
        albedo[to] = r;
        albedo[to + 1] = g;
        albedo[to + 2] = b;
        albedo[to + 3] = Math.round(a * 255);
      }
    alphas.push(alpha);
  });
  stepMs.cropAndKey = Math.round(performance.now() - start);

  start = performance.now();
  USED.forEach((frame, i) => {
    const { column, row } = cells.get(frame) ?? { column: 0, row: 0 };
    const alpha = alphas[i] ?? new Float32Array(w * h);
    const dome = blur(alpha, w, h, 6, 3);
    const heightAt = (x: number, y: number) => {
      const cx = Math.min(w - 1, Math.max(0, x));
      const cy = Math.min(h - 1, Math.max(0, y));
      const to = ((row * h + cy) * width + column * w + cx) * 4;
      const luma =
        ((albedo[to] ?? 0) * 0.3 + (albedo[to + 1] ?? 0) * 0.59 + (albedo[to + 2] ?? 0) * 0.11) /
        255;
      return 0.75 * (dome[cy * w + cx] ?? 0) + 0.25 * luma * (alpha[cy * w + cx] ?? 0);
    };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const to = ((row * h + y) * width + column * w + x) * 4;
        // Sobel gradient of height; +y of the normal is up the image.
        const dx =
          heightAt(x + 1, y - 1) +
          2 * heightAt(x + 1, y) +
          heightAt(x + 1, y + 1) -
          heightAt(x - 1, y - 1) -
          2 * heightAt(x - 1, y) -
          heightAt(x - 1, y + 1);
        const dy =
          heightAt(x - 1, y - 1) +
          2 * heightAt(x, y - 1) +
          heightAt(x + 1, y - 1) -
          heightAt(x - 1, y + 1) -
          2 * heightAt(x, y + 1) -
          heightAt(x + 1, y + 1);
        const strength = 6;
        const nx = -dx * strength;
        const ny = dy * strength;
        const length = Math.hypot(nx, ny, 1);
        normal[to] = Math.round((nx / length) * 127.5 + 127.5);
        normal[to + 1] = Math.round((ny / length) * 127.5 + 127.5);
        normal[to + 2] = Math.round((1 / length) * 127.5 + 127.5);
        normal[to + 3] = 255;
        // The shared edge treatment: a 1-pixel dark line just inside the silhouette.
        const a = alpha[y * w + x] ?? 0;
        const edge =
          a > 0.5 &&
          [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ].some(
            ([ox = 0, oy = 0]) =>
              (alpha[
                Math.min(h - 1, Math.max(0, y + oy)) * w + Math.min(w - 1, Math.max(0, x + ox))
              ] ?? 0) < 0.5,
          );
        if (edge) {
          albedo[to] = 28;
          albedo[to + 1] = 20;
          albedo[to + 2] = 16;
        }
      }
  });
  stepMs.deriveNormalAndEdge = Math.round(performance.now() - start);
  return {
    width,
    height,
    albedo,
    normal,
    columns: ATLAS_COLUMNS,
    rows,
    cell: (frame) => cells.get(frame) ?? { column: 0, row: 0 },
    stepMs,
  };
}
