/**
 * The cover painter for VICE COVER STUDIO.
 *
 * drawCover() paints the whole cover onto any 2D context at any pixel size. The preview canvas and the
 * exported PNG both call this one function, so the download is exactly the picture the editor shows.
 * Everything here is drawn by hand: the poster matte, the panel layouts, the three colour grades
 * (canvas filters, gradient overlays, tinted highlight/shadow passes, a halftone dot screen, a vignette
 * and film grain), the heavy condensed lettering with its outline and drop shadow, and the print marks.
 *
 * Grades are computed once per photo and cached (see gradePhoto), so dragging a crop inside a panel
 * costs two drawImage calls, not a fresh stack of filter passes.
 */

/** The display face: Anton, shipped under the OFL in app/fonts/. */
export const TITLE_FONT = '"Anton", "Arial Narrow", Impact, sans-serif';

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** The three cover layouts. Rects are fractions of the cover, so every post size scales cleanly. */
export const LAYOUTS = [
  {
    id: 'classic',
    name: 'Classic',
    hint: 'Hero left, two stacked right',
    panels: [
      { x: 0.03, y: 0.034, w: 0.598, h: 0.932 },
      { x: 0.648, y: 0.034, w: 0.322, h: 0.449 },
      { x: 0.648, y: 0.517, w: 0.322, h: 0.449 },
    ],
  },
  {
    id: 'grid',
    name: 'Grid',
    hint: 'Two by two',
    panels: [
      { x: 0.03, y: 0.034, w: 0.455, h: 0.449 },
      { x: 0.515, y: 0.034, w: 0.455, h: 0.449 },
      { x: 0.03, y: 0.517, w: 0.455, h: 0.449 },
      { x: 0.515, y: 0.517, w: 0.455, h: 0.449 },
    ],
  },
  {
    id: 'triptych',
    name: 'Triptych',
    hint: 'Three tall panels',
    panels: [
      { x: 0.03, y: 0.034, w: 0.3, h: 0.932 },
      { x: 0.35, y: 0.034, w: 0.3, h: 0.932 },
      { x: 0.67, y: 0.034, w: 0.3, h: 0.932 },
    ],
  },
];

/** The grade presets, with the swatch the sidebar paints for each. */
export const GRADES = [
  {
    id: 'sunset',
    name: 'Sunset',
    hint: 'Warm orange-pink, lifted shadows, golden highlights',
    swatch: 'linear-gradient(140deg, #ffd35a 0%, #ff8a4d 42%, #e8407b 74%, #5c1f6e 100%)',
  },
  {
    id: 'neon',
    name: 'Neon Night',
    hint: 'Magenta-cyan duotone, glowing edges, deep blue shadows',
    swatch: 'linear-gradient(140deg, #ff2f9a 0%, #8a3cff 48%, #1fe3ff 100%)',
  },
  {
    id: 'pastel',
    name: 'Vice Pastel',
    hint: 'Soft pink-teal, light and airy',
    swatch: 'linear-gradient(140deg, #ffd7ea 0%, #f7bfd6 38%, #bfe9e4 100%)',
  },
];

/** The three post sizes the editor offers, in pixels. */
export function coverSize(id) {
  if (id === '1080x1350') return { w: 1080, h: 1350 };
  if (id === '1920x1080') return { w: 1920, h: 1080 };
  return { w: 1080, h: 1080 };
}

/** Panel rectangles in device pixels for a layout at a given cover size. */
export function panelRects(layoutId, width, height) {
  const layout = LAYOUTS.find((l) => l.id === layoutId) ?? LAYOUTS[0];
  return layout.panels.map((p) => ({
    x: Math.round(p.x * width),
    y: Math.round(p.y * height),
    w: Math.round(p.w * width),
    h: Math.round(p.h * height),
  }));
}

/**
 * How a photo is scaled and shifted inside a panel: the cover-fit draw size and how far the image
 * may slide in each direction. Shared with the editor so dragging and drawing agree exactly.
 */
export function coverDrawRect(img, pw, ph, crop) {
  const zoom = Math.max(1, crop?.zoom ?? 1);
  const s = Math.max(pw / img.width, ph / img.height) * zoom;
  const dw = img.width * s;
  const dh = img.height * s;
  return { dw, dh, mx: Math.max(0, (dw - pw) / 2), my: Math.max(0, (dh - ph) / 2) };
}

// ---------------------------------------------------------------- deterministic texture

/** A tiny seeded PRNG, so the grain is the same on every load, every redraw and every export. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let grainTile = null;
function grainTileCanvas() {
  if (grainTile) return grainTile;
  // Noise in 2x2 blocks: at poster size that reads as film grain, and it compresses far better than
  // per-pixel noise (which would turn every exported PNG into megabytes of entropy).
  const cell = 3;
  const cells = 96;
  const size = cell * cells;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const data = g.createImageData(size, size);
  const rnd = mulberry32(0x6167a6);
  const values = new Float32Array(cells * cells);
  for (let i = 0; i < values.length; i++) values[i] = 128 + (rnd() * 2 - 1) * 92;
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / cell) * cells;
    for (let x = 0; x < size; x++) {
      const v = values[row + Math.floor(x / cell)];
      const o = (y * size + x) * 4;
      data.data[o] = v;
      data.data[o + 1] = v;
      data.data[o + 2] = v;
      data.data[o + 3] = 255;
    }
  }
  g.putImageData(data, 0, 0);
  grainTile = canvas;
  return canvas;
}

let dotTile = null;
function halftoneTileCanvas() {
  if (dotTile) return dotTile;
  const size = 10;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000000';
  for (const [cx, cy] of [
    [2.5, 2.5],
    [7.5, 7.5],
  ]) {
    g.beginPath();
    g.arc(cx, cy, 1.85, 0, Math.PI * 2);
    g.fill();
  }
  dotTile = canvas;
  return dotTile;
}

function tilePattern(ctx, tile, scale) {
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return null;
  if (scale !== 1 && typeof pattern.setTransform === 'function') {
    try {
      pattern.setTransform(new DOMMatrix().scaleSelf(scale, scale));
    } catch {
      /* an older engine simply keeps the tile's own size */
    }
  }
  return pattern;
}

// ---------------------------------------------------------------- scratch plates

let tintScratch = null;
function tintCanvas(w, h) {
  if (!tintScratch) tintScratch = document.createElement('canvas');
  if (tintScratch.width !== w || tintScratch.height !== h) {
    tintScratch.width = w;
    tintScratch.height = h;
  }
  return tintScratch;
}

/**
 * Adds one tinted band of a photo: the photo is filtered down to the tones wanted (bright highlights, or
 * inverted shadows), flat-filled with `color` through 'multiply', then laid over the plate with `op`.
 * This is how the neon duotone gets magenta in the shadows and cyan in the highlights without a pixel loop.
 */
function tintedPass(dest, src, filter, color, op, alpha) {
  const w = dest.canvas.width;
  const h = dest.canvas.height;
  const plate = tintCanvas(w, h);
  const t = plate.getContext('2d');
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalAlpha = 1;
  t.globalCompositeOperation = 'source-over';
  t.filter = 'none';
  t.clearRect(0, 0, w, h);
  t.filter = filter;
  t.drawImage(src, 0, 0, w, h);
  t.filter = 'none';
  t.globalCompositeOperation = 'multiply';
  t.fillStyle = color;
  t.fillRect(0, 0, w, h);

  dest.save();
  dest.globalCompositeOperation = op;
  dest.globalAlpha = alpha;
  dest.drawImage(plate, 0, 0);
  dest.restore();
}

// ---------------------------------------------------------------- the three grades

function gradeSunset(g, src, w, h) {
  g.filter = 'saturate(1.32) contrast(1.06) brightness(1.04)';
  g.drawImage(src, 0, 0, w, h);
  g.filter = 'none';

  g.globalCompositeOperation = 'soft-light';
  g.globalAlpha = 0.95;
  const sky = g.createLinearGradient(0, 0, w * 0.3, h);
  sky.addColorStop(0, '#ffd45e');
  sky.addColorStop(0.34, '#ff8f4d');
  sky.addColorStop(0.68, '#f0407c');
  sky.addColorStop(1, '#5c1f6e');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  g.globalCompositeOperation = 'screen';
  g.globalAlpha = 0.24;
  const glow = g.createRadialGradient(w * 0.3, h * 0.14, 0, w * 0.3, h * 0.14, Math.max(w, h) * 0.9);
  glow.addColorStop(0, 'rgba(255, 208, 140, 0.95)');
  glow.addColorStop(0.5, 'rgba(255, 150, 110, 0.34)');
  glow.addColorStop(1, 'rgba(255, 120, 120, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);

  // 'lighten' against a uniform warm tone lifts the blacks without fogging the highlights.
  g.globalCompositeOperation = 'lighten';
  g.globalAlpha = 0.32;
  g.fillStyle = '#2b1424';
  g.fillRect(0, 0, w, h);

  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = 0.22;
  const shade = g.createLinearGradient(0, h * 0.4, 0, h);
  shade.addColorStop(0, 'rgba(70, 20, 60, 0)');
  shade.addColorStop(1, 'rgba(52, 12, 48, 1)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  tintedPass(g, src, 'grayscale(1) brightness(1.75) contrast(2.3)', '#ffd77a', 'screen', 0.34);
}

function gradeNeon(g, src, w, h) {
  g.filter = 'grayscale(1) contrast(1.28) brightness(0.92)';
  g.drawImage(src, 0, 0, w, h);
  g.filter = 'none';

  // Bloom: a blurred, brightened copy screened over the plate makes edges come alight.
  g.globalCompositeOperation = 'screen';
  g.globalAlpha = 0.34;
  g.filter = 'grayscale(1) blur(7px) brightness(1.5) contrast(1.5)';
  g.drawImage(src, 0, 0, w, h);
  g.filter = 'none';
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  // Duotone: the 'color' blend keeps each pixel's own brightness and takes the gradient's hue, so the
  // shadows turn magenta-violet and the highlights cyan in one pass.
  g.globalCompositeOperation = 'color';
  const duo = g.createLinearGradient(0, h, w, 0);
  duo.addColorStop(0, '#c9168a');
  duo.addColorStop(0.34, '#ff2f9a');
  duo.addColorStop(0.62, '#7b5cff');
  duo.addColorStop(1, '#3ce6ff');
  g.fillStyle = duo;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  // Deep blue in the shadows, a violet glow at the top.
  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = 0.66;
  const deep = g.createLinearGradient(0, 0, 0, h);
  deep.addColorStop(0, 'rgba(150, 170, 255, 0.1)');
  deep.addColorStop(0.5, 'rgba(34, 26, 120, 0.4)');
  deep.addColorStop(1, 'rgba(8, 10, 62, 0.92)');
  g.fillStyle = deep;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;

  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = 0.34;
  const rim = g.createRadialGradient(w * 0.18, h * 0.06, 0, w * 0.18, h * 0.06, Math.max(w, h) * 0.86);
  rim.addColorStop(0, 'rgba(255, 60, 170, 0.9)');
  rim.addColorStop(1, 'rgba(255, 60, 170, 0)');
  g.fillStyle = rim;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

function gradePastel(g, src, w, h) {
  g.filter = 'saturate(0.88) brightness(1.2) contrast(0.9)';
  g.drawImage(src, 0, 0, w, h);
  g.filter = 'none';

  // Pink above, teal below: a soft wash that keeps the photo readable instead of bleaching it.
  g.globalCompositeOperation = 'soft-light';
  g.globalAlpha = 0.95;
  const wash = g.createLinearGradient(0, 0, w * 0.35, h);
  wash.addColorStop(0, '#ffb6d6');
  wash.addColorStop(0.45, '#f0a6c8');
  wash.addColorStop(0.62, '#d9c4dc');
  wash.addColorStop(1, '#7fd6cf');
  g.fillStyle = wash;
  g.fillRect(0, 0, w, h);

  g.globalCompositeOperation = 'screen';
  g.globalAlpha = 0.13;
  g.fillStyle = '#fff2f8';
  g.fillRect(0, 0, w, h);

  // Airy, not grey: lift the blacks with a pale tone, then let teal pool at the bottom.
  g.globalCompositeOperation = 'lighten';
  g.globalAlpha = 0.38;
  g.fillStyle = '#9a8ea8';
  g.fillRect(0, 0, w, h);

  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = 0.24;
  const teal = g.createLinearGradient(0, h * 0.32, 0, h);
  teal.addColorStop(0, 'rgba(120, 200, 205, 0)');
  teal.addColorStop(1, 'rgba(88, 160, 178, 1)');
  g.fillStyle = teal;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  tintedPass(g, src, 'grayscale(1) brightness(1.5) contrast(2)', '#ffc9dd', 'screen', 0.18);
}

/**
 * The graded copy of one photo, built once and kept on the photo object. Its aspect ratio matches the
 * source, so the editor's crop maths works against it unchanged; the cap keeps a big camera file from
 * making every redraw expensive.
 */
const GRADE_MAX_SIDE = 1700;

function gradePhoto(photo, gradeId) {
  if (!photo || !photo.img || !photo.img.width) return null;
  const key = `${gradeId}`;
  if (photo.graded && photo.graded.key === key) return photo.graded.canvas;

  const src = photo.img;
  const scale = Math.min(1, GRADE_MAX_SIDE / Math.max(src.width, src.height));
  const w = Math.max(2, Math.round(src.width * scale));
  const h = Math.max(2, Math.round(src.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';

  if (gradeId === 'neon') gradeNeon(g, src, w, h);
  else if (gradeId === 'pastel') gradePastel(g, src, w, h);
  else gradeSunset(g, src, w, h);

  g.filter = 'none';
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  photo.graded = { key, canvas };
  return canvas;
}

// ---------------------------------------------------------------- panels

/** The per-panel finishing screen: vignette, halftone dots and grain, cached per panel size. */
const overlayCache = new Map();
function panelOverlay(w, h, unit) {
  const key = `${w}x${h}`;
  const hit = overlayCache.get(key);
  if (hit) return hit;
  if (overlayCache.size > 24) overlayCache.clear();

  const vignette = document.createElement('canvas');
  vignette.width = w;
  vignette.height = h;
  const vg = vignette.getContext('2d');
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  const grad = vg.createRadialGradient(w / 2, h * 0.45, short * 0.18, w / 2, h * 0.5, long * 0.76);
  grad.addColorStop(0, 'rgba(8, 3, 12, 0)');
  grad.addColorStop(0.66, 'rgba(8, 3, 12, 0.16)');
  grad.addColorStop(1, 'rgba(8, 3, 12, 0.66)');
  vg.fillStyle = grad;
  vg.fillRect(0, 0, w, h);

  const entry = { vignette, unit };
  overlayCache.set(key, entry);
  return entry;
}

function paintPanel(ctx, rect, panel, photos, gradeId, intensity, unit) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));

  ctx.save();
  ctx.shadowColor = 'rgba(4, 2, 8, 0.65)';
  ctx.shadowBlur = unit * 16;
  ctx.shadowOffsetY = unit * 7;
  ctx.fillStyle = '#08050c';
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  const photo = panel && panel.photo !== null && panel.photo !== undefined ? photos[panel.photo] : null;
  const crop = panel?.crop ?? { zoom: 1, nx: 0, ny: 0 };

  if (photo && photo.img && photo.img.width > 0) {
    const graded = gradePhoto(photo, gradeId);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const draw = (img, alpha) => {
      const fit = coverDrawRect(img, w, h, crop);
      const dx = (w - fit.dw) / 2 + clamp(crop.nx ?? 0, -1, 1) * fit.mx;
      const dy = (h - fit.dh) / 2 + clamp(crop.ny ?? 0, -1, 1) * fit.my;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x + dx, y + dy, fit.dw, fit.dh);
    };

    // The intensity slider is a straight blend between the untouched photo and its graded copy.
    const amount = clamp(intensity, 0, 1);
    if (amount < 0.999) draw(photo.img, 1);
    if (graded && amount > 0.001) draw(graded, amount);
    ctx.globalAlpha = 1;

    // Vignette, halftone screen and grain finish every panel, and fade with the grade.
    if (amount > 0.001) {
      const overlay = panelOverlay(w, h, unit);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = amount;
      ctx.drawImage(overlay.vignette, x, y);
      ctx.globalAlpha = 1;

      const dots = tilePattern(ctx, halftoneTileCanvas(), unit);
      if (dots) {
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.4 * amount;
        ctx.fillStyle = dots;
        ctx.fillRect(x, y, w, h);
      }

      const grain = tilePattern(ctx, grainTileCanvas(), unit);
      if (grain) {
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = 0.15 * amount;
        ctx.fillStyle = grain;
        ctx.fillRect(x, y, w, h);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#150d1d';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255, 61, 134, 0.2)';
    ctx.lineWidth = Math.max(1, unit * 2);
    const step = Math.max(8, unit * 24);
    ctx.beginPath();
    for (let i = -h; i < w + h; i += step) {
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(246, 231, 211, 0.6)';
    ctx.font = `${Math.round(Math.min(w, h) * 0.052)}px ${TITLE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ADD PHOTO', x + w / 2, y + h / 2);
    ctx.restore();
  }

  // A printed hairline inside each panel edge.
  ctx.save();
  ctx.strokeStyle = 'rgba(247, 234, 214, 0.9)';
  ctx.lineWidth = Math.max(1, unit * 2.6);
  ctx.strokeRect(x + unit * 3.5, y + unit * 3.5, w - unit * 7, h - unit * 7);
  ctx.strokeStyle = 'rgba(10, 5, 14, 0.5)';
  ctx.lineWidth = Math.max(1, unit * 1.2);
  ctx.strokeRect(x + unit * 6, y + unit * 6, w - unit * 12, h - unit * 12);
  ctx.restore();
}

// ---------------------------------------------------------------- lettering

function setTitleFont(ctx, size) {
  ctx.font = `${size}px ${TITLE_FONT}`;
}

/** The width of `text` once `tracking` pixels are added between each pair of letters. */
function measureTracked(ctx, text, tracking) {
  const chars = [...text];
  let width = 0;
  for (const ch of chars) width += ctx.measureText(ch).width;
  return width + tracking * Math.max(0, chars.length - 1);
}

function drawTracked(ctx, text, cx, baseline, tracking) {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const width = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let x = cx - width / 2;
  ctx.textAlign = 'left';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, baseline);
    x += widths[i] + tracking;
  }
  return width;
}

/**
 * Fits a title the way a poster does: the biggest type that still spans the width, on one line when it
 * can, otherwise stacked over two balanced lines. A stack is only taken when it really buys size and
 * its total height still leaves the cover to the artwork.
 */
function layoutTitle(ctx, text, maxWidth, maxSize, maxBlockHeight) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size: maxSize, widths: [] };

  const measure = (lines) => {
    setTitleFont(ctx, 100);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (widest <= 0) return null;
    let size = Math.min(maxSize, (maxWidth / widest) * 100);
    if (maxBlockHeight) size = Math.min(size, maxBlockHeight / (lines.length * 0.86));
    return { lines, size };
  };

  const single = measure([words.join(' ')]);
  let best = single;

  if (words.length > 1) {
    let pair = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      setTitleFont(ctx, 100);
      const spread = Math.abs(ctx.measureText(a).width - ctx.measureText(b).width);
      if (!pair || spread < pair.spread) pair = { spread, lines: [a, b] };
    }
    const stacked = pair ? measure(pair.lines) : null;
    // A stack has to earn its extra height: clearly larger type, not merely a little.
    if (stacked && (!best || stacked.size > best.size * 1.14)) best = stacked;
  }

  if (!best) return { lines: [text], size: maxSize, widths: [] };
  setTitleFont(ctx, best.size);
  return { lines: best.lines, size: best.size, widths: best.lines.map((l) => ctx.measureText(l).width) };
}

/** One line of poster lettering: dark outer stroke, cream keyline, warm gradient fill, drop shadow. */
function drawTitleLine(ctx, text, cx, baseline, size) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  ctx.shadowColor = 'rgba(6, 2, 10, 0.6)';
  ctx.shadowBlur = size * 0.22;
  ctx.shadowOffsetY = size * 0.08;
  ctx.strokeStyle = '#170b19';
  ctx.lineWidth = size * 0.16;
  ctx.strokeText(text, cx, baseline);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = '#f8ecd6';
  ctx.lineWidth = size * 0.042;
  ctx.strokeText(text, cx, baseline);

  const fill = ctx.createLinearGradient(0, baseline - size * 0.8, 0, baseline + size * 0.03);
  fill.addColorStop(0, '#fff6e2');
  fill.addColorStop(0.4, '#ffdfa8');
  fill.addColorStop(0.76, '#ffa8c6');
  fill.addColorStop(1, '#ff86bd');
  ctx.fillStyle = fill;
  ctx.fillText(text, cx, baseline);
  ctx.restore();
}

/** Draws the caption block and returns the boxes the editor puts its in-place fields over. */
function drawCaption(ctx, w, h, state, unit) {
  const titleText = String(state.title ?? '').toUpperCase().trim();
  const tagText = String(state.tagline ?? '').toUpperCase().trim();
  if (!titleText && !tagText) return { title: null, tagline: null };

  const position = state.titlePos === 'top' || state.titlePos === 'middle' ? state.titlePos : 'bottom';
  const maxWidth = w * 0.88;
  const maxSize = Math.min(w, h) * 0.19 * clamp(Number(state.titleSize) || 1, 0.5, 1.5);
  // Room the title block may take. Bottom and top get a generous band (poster lettering dominates a cover);
  // the middle placement stays tighter so the artwork keeps its centre.
  const maxBlockHeight = h * (position === 'middle' ? 0.24 : 0.27);
  const fit = titleText
    ? layoutTitle(ctx, titleText, maxWidth, maxSize, maxBlockHeight * 0.9)
    : { lines: [], size: maxSize, widths: [] };
  const lineHeight = fit.size * 0.86;
  const tagSize = clamp(fit.size * 0.185, unit * 13, unit * 34);
  const titleHeight = fit.lines.length * lineHeight;
  const tagGap = tagText ? (fit.lines.length ? fit.size * 0.1 : 0) + tagSize * 1.5 : 0;
  const blockHeight = titleHeight + tagGap + (tagText ? tagSize : 0);

  let top;
  if (position === 'top') top = h * 0.055;
  else if (position === 'middle') top = h * 0.5 - blockHeight * 0.52;
  else top = h * 0.945 - blockHeight;

  // The scrim that keeps the type legible over any photo: strong behind the letters, gone by mid-cover.
  ctx.save();
  if (position === 'middle') {
    const scrim = ctx.createRadialGradient(w / 2, top + blockHeight / 2, 0, w / 2, top + blockHeight / 2, Math.max(w, h) * 0.72);
    scrim.addColorStop(0, 'rgba(9, 5, 13, 0.66)');
    scrim.addColorStop(0.45, 'rgba(9, 5, 13, 0.34)');
    scrim.addColorStop(1, 'rgba(9, 5, 13, 0)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, w, h);
  } else if (position === 'top') {
    const scrim = ctx.createLinearGradient(0, 0, 0, h * 0.56);
    scrim.addColorStop(0, 'rgba(9, 5, 13, 0.84)');
    scrim.addColorStop(0.5, 'rgba(9, 5, 13, 0.4)');
    scrim.addColorStop(1, 'rgba(9, 5, 13, 0)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, w, h * 0.56);
  } else {
    const scrim = ctx.createLinearGradient(0, h * 0.54, 0, h);
    scrim.addColorStop(0, 'rgba(9, 5, 13, 0)');
    scrim.addColorStop(0.55, 'rgba(9, 5, 13, 0.42)');
    scrim.addColorStop(1, 'rgba(9, 5, 13, 0.9)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, h * 0.54, w, h * 0.46);
  }
  ctx.restore();

  if (state.editing !== 'title' && titleText) {
    let baseline = top + fit.size * 0.8;
    for (let i = 0; i < fit.lines.length; i++) {
      drawTitleLine(ctx, fit.lines[i], w / 2, baseline, fit.size);
      baseline += lineHeight;
    }
  }

  let tagBox = null;
  if (state.editing !== 'tagline' && tagText) {
    const baseline = top + titleHeight + (fit.lines.length ? fit.size * 0.1 : 0) + tagSize * 1.15;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${tagSize}px ${TITLE_FONT}`;
    const tracking = tagSize * 0.32;
    const textWidth = measureTracked(ctx, tagText, tracking);
    const padX = tagSize * 0.85;
    const padY = tagSize * 0.5;
    const plateW = textWidth + padX * 2;
    const plateH = tagSize + padY * 2;
    const plateX = w / 2 - plateW / 2;
    const plateY = baseline - tagSize - padY + tagSize * 0.12;

    // A ticket-like plate: dark bar, hairline frame, small corner notches.
    ctx.fillStyle = 'rgba(11, 5, 16, 0.8)';
    ctx.fillRect(plateX, plateY, plateW, plateH);
    ctx.strokeStyle = 'rgba(255, 168, 198, 0.8)';
    ctx.lineWidth = Math.max(1, unit * 1.8);
    ctx.strokeRect(plateX + unit * 3, plateY + unit * 3, plateW - unit * 6, plateH - unit * 6);
    ctx.fillStyle = 'rgba(255, 168, 198, 0.9)';
    const notch = Math.max(2, unit * 4);
    for (const [nx, ny] of [
      [plateX, plateY],
      [plateX + plateW - notch, plateY],
      [plateX, plateY + plateH - notch],
      [plateX + plateW - notch, plateY + plateH - notch],
    ]) {
      ctx.fillRect(nx, ny, notch, notch);
    }

    ctx.fillStyle = '#fbeed8';
    drawTracked(ctx, tagText, w / 2, baseline, tracking);
    ctx.restore();
    tagBox = { x: plateX, y: plateY, w: plateW, h: plateH, fontSize: tagSize, tracking };
  }

  const widest = fit.widths.length ? Math.max(...fit.widths) : 0;
  const titleBox = titleText
    ? {
        x: w / 2 - widest / 2 - fit.size * 0.06,
        y: top,
        w: widest + fit.size * 0.12,
        h: Math.max(lineHeight, titleHeight),
        fontSize: fit.size,
        tracking: 0,
      }
    : null;

  return { title: titleBox, tagline: tagBox };
}

// ---------------------------------------------------------------- the frame

function drawFrameMarks(ctx, w, h, unit) {
  ctx.save();
  ctx.strokeStyle = 'rgba(247, 234, 214, 0.4)';
  ctx.lineWidth = Math.max(1, unit * 1.6);
  const inset = unit * 13;
  const arm = unit * 22;
  const corners = [
    [inset, inset, 1, 1],
    [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1],
    [w - inset, h - inset, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + sy * arm);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sx * arm, cy);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = 'rgba(247, 234, 214, 0.8)';
  ctx.font = `${Math.max(7, Math.round(unit * 11))}px ${TITLE_FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  ctx.fillText('VICE COVER STUDIO', w - unit * 28, h - unit * 22);
  ctx.restore();
}

/**
 * Paints the whole cover. Returns the caption boxes (in cover pixels) so the editor can place its
 * in-place text fields; a line that is empty gets a null box.
 */
export function drawCover(ctx, width, height, state) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const unit = Math.min(w, h) / 1080;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);

  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, '#1d1126');
  base.addColorStop(0.5, '#120a19');
  base.addColorStop(1, '#08050d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Two soft stage lights behind the panels give the matte some air.
  const pink = ctx.createRadialGradient(w * 0.12, h * 0.08, 0, w * 0.12, h * 0.08, Math.max(w, h) * 0.75);
  pink.addColorStop(0, 'rgba(255, 60, 140, 0.22)');
  pink.addColorStop(1, 'rgba(255, 60, 140, 0)');
  ctx.fillStyle = pink;
  ctx.fillRect(0, 0, w, h);

  const cyan = ctx.createRadialGradient(w * 0.9, h * 0.95, 0, w * 0.9, h * 0.95, Math.max(w, h) * 0.7);
  cyan.addColorStop(0, 'rgba(60, 200, 255, 0.14)');
  cyan.addColorStop(1, 'rgba(60, 200, 255, 0)');
  ctx.fillStyle = cyan;
  ctx.fillRect(0, 0, w, h);

  const rects = panelRects(state.layout, w, h);
  for (let i = 0; i < rects.length; i++) {
    paintPanel(ctx, rects[i], state.panels?.[i], state.photos ?? [], state.grade ?? 'sunset', Number(state.intensity ?? 0.85), unit);
  }

  const boxes = drawCaption(ctx, w, h, state, unit);
  drawFrameMarks(ctx, w, h, unit);

  // Print texture over everything, then the final vignette.
  const grain = tilePattern(ctx, grainTileCanvas(), unit);
  if (grain) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const vignette = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.32, w / 2, h * 0.5, Math.max(w, h) * 0.82);
  vignette.addColorStop(0, 'rgba(6, 3, 10, 0)');
  vignette.addColorStop(0.72, 'rgba(6, 3, 10, 0.16)');
  vignette.addColorStop(1, 'rgba(6, 3, 10, 0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  ctx.restore();
  return boxes;
}
