/**
 * VICE COVER STUDIO — the editor.
 *
 * Holds the cover state (photos, panel crops, layout, grade, caption), paints the preview by calling
 * drawCover() at the display size, and paints the export by calling the very same function at the post
 * size, so the PNG a person downloads is the picture they were looking at. Photos stay in memory as
 * decoded <img> elements made from blob URLs; nothing ever leaves the machine.
 */
import { GRADES, LAYOUTS, coverDrawRect, coverSize, drawCover } from './render.js';

const filePicker = document.getElementById('filePicker');
const trayList = document.getElementById('trayList');
const panelList = document.getElementById('panelList');
const layoutRow = document.getElementById('layouts');
const gradeRow = document.getElementById('grades');
const canvas = document.getElementById('cover');
const wrap = document.getElementById('canvasWrap');
const statusEl = document.getElementById('status');
const capTitle = document.getElementById('capTitle');
const capTag = document.getElementById('capTag');
const intensity = document.getElementById('intensity');
const intensityOut = document.getElementById('intensityOut');
const titleText = document.getElementById('titleText');
const taglineText = document.getElementById('taglineText');
const titleScale = document.getElementById('titleScale');
const titleScaleOut = document.getElementById('titleScaleOut');
const panelZoom = document.getElementById('panelZoom');
const panelZoomOut = document.getElementById('panelZoomOut');
const exportSize = document.getElementById('exportSize');
const panelNote = document.getElementById('panelNote');
const gradeNote = document.getElementById('gradeNote');
const photoNote = document.getElementById('photoNote');

const state = {
  photos: [],
  panels: [],
  layout: 'classic',
  grade: 'sunset',
  intensity: 0.85,
  size: '1080x1080',
  title: 'VICE AFTER DARK',
  tagline: 'A CITY THAT NEVER SLEEPS',
  titlePos: 'bottom',
  titleScale: 1,
  selectedPanel: 0,
  selectedPhoto: 0,
  editing: null,
};

let boxes = null;
let raf = 0;
let paintWidth = 0;
const ctx = canvas.getContext('2d');

// ---------------------------------------------------------------- photos

/** Decodes a File (or blob URL) into an <img> ready to draw, keeping the URL alive for redraws. */
function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'sync';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not an image the browser can decode.'));
    img.src = url;
  });
}

let photoSeq = 0;
async function addPhotoFile(file) {
  if (!file || !/^image\//.test(file.type || '')) {
    flash('Only image files can go in a panel.');
    return null;
  }
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await decodeImage(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    flash(err.message);
    return null;
  }
  photoSeq += 1;
  const photo = {
    id: `p${photoSeq}`,
    img,
    url,
    label: (file.name || 'photo').replace(/\.[^.]+$/, '').slice(0, 22) || `Photo ${photoSeq}`,
  };
  state.photos.push(photo);
  return photo;
}

function addSample(name, label) {
  return decodeImage(`./samples/${name}.jpg`).then((img) => {
    photoSeq += 1;
    state.photos.push({ id: `p${photoSeq}`, img, url: `./samples/${name}.jpg`, label });
  });
}

function usesOf(index) {
  return state.panels.filter((p) => p && p.photo === index).length;
}

// ---------------------------------------------------------------- panels

function panelCount() {
  return (LAYOUTS.find((l) => l.id === state.layout) ?? LAYOUTS[0]).panels.length;
}

/** Fits the panel list to the layout, keeping each panel's photo and crop by index. */
function resizePanels() {
  const n = panelCount();
  const next = [];
  for (let i = 0; i < n; i++) {
    next.push(state.panels[i] ?? { photo: state.photos.length ? i % state.photos.length : null, crop: { zoom: 1, nx: 0, ny: 0 } });
  }
  state.panels = next;
  if (state.selectedPanel >= n) state.selectedPanel = n - 1;
}

function assignPhoto(panelIndex, photoIndex) {
  const panel = state.panels[panelIndex];
  if (!panel) return;
  panel.photo = photoIndex;
  panel.crop = { zoom: 1, nx: 0, ny: 0 };
  state.selectedPhoto = photoIndex;
  state.selectedPanel = panelIndex;
  schedule();
  renderPanelList();
  renderTray();
}

function removePhotoFrom(panelIndex) {
  const panel = state.panels[panelIndex];
  if (!panel) return;
  panel.photo = null;
  panel.crop = { zoom: 1, nx: 0, ny: 0 };
  schedule();
  renderPanelList();
  renderTray();
}

// ---------------------------------------------------------------- drawing

function displaySize() {
  const { w, h } = coverSize(state.size);
  const narrow = window.innerWidth <= 1220;
  const railW = narrow ? 224 + 244 : 250 + 268;
  const availW = Math.max(300, Math.min(window.innerWidth - railW - 76, 900));
  const availH = Math.max(300, window.innerHeight - 122);
  const scale = Math.min(availW / w, availH / h);
  return { w: Math.max(240, Math.round(w * scale)), h: Math.max(240, Math.round(h * scale)) };
}

function paint() {
  raf = 0;
  const { w, h } = displaySize();
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const pixelW = Math.round(w * dpr);
  const pixelH = Math.round(h * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  paintWidth = w;

  // The preview paints at its own pixel size: the same function as the export, just fewer pixels.
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  boxes = drawCover(ctx, w, h, {
    layout: state.layout,
    panels: state.panels,
    photos: state.photos,
    grade: state.grade,
    intensity: state.intensity,
    title: state.title,
    tagline: state.tagline,
    titlePos: state.titlePos,
    titleSize: state.titleScale,
    editing: state.editing,
  });
  ctx.restore();

  positionCaptionFields();
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(paint);
}

/** Puts the two in-place fields over the caption block, in the preview's own pixel space. */
function positionCaptionFields() {
  const k = paintWidth > 0 ? canvas.clientWidth / paintWidth : 1;
  const place = (el, box, lineHeight) => {
    if (!box) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = `${box.x * k}px`;
    el.style.top = `${box.y * k}px`;
    el.style.width = `${Math.max(40, box.w * k)}px`;
    el.style.height = `${Math.max(16, box.h * k)}px`;
    el.style.fontSize = `${Math.max(9, box.fontSize * k)}px`;
    el.style.lineHeight = String(lineHeight);
    el.style.letterSpacing = `${box.tracking * k}px`;
  };
  place(capTitle, boxes?.title ?? null, 0.86);
  place(capTag, boxes?.tagline ?? null, 1.0);
}

// ---------------------------------------------------------------- controls

function renderLayouts() {
  layoutRow.innerHTML = '';
  for (const layout of LAYOUTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `layout-btn${layout.id === state.layout ? ' on' : ''}`;
    btn.title = layout.hint;
    btn.dataset.layout = layout.id;
    const W = 62;
    const H = 48;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    for (const p of layout.panels) {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(1 + p.x * (W - 2)));
      r.setAttribute('y', String(1 + p.y * (H - 2)));
      r.setAttribute('width', String(p.w * (W - 2)));
      r.setAttribute('height', String(p.h * (H - 2)));
      r.setAttribute('rx', '1.4');
      r.setAttribute('fill', 'currentColor');
      svg.appendChild(r);
    }
    btn.appendChild(svg);
    const label = document.createElement('span');
    label.textContent = layout.name;
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (state.layout === layout.id) return;
      state.layout = layout.id;
      resizePanels();
      renderLayouts();
      renderPanelList();
      syncZoomRow();
      flash(`${layout.name} layout · ${layout.hint.toLowerCase()}`);
      schedule();
    });
    layoutRow.appendChild(btn);
  }
}

function renderGrades() {
  gradeRow.innerHTML = '';
  for (const grade of GRADES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `grade-btn${grade.id === state.grade ? ' on' : ''}`;
    btn.dataset.grade = grade.id;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = grade.swatch;
    const text = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'grade-name';
    name.textContent = grade.name;
    const hint = document.createElement('span');
    hint.className = 'grade-hint';
    hint.textContent = grade.hint;
    text.append(name, document.createElement('br'), hint);
    btn.append(swatch, text);
    btn.addEventListener('click', () => {
      state.grade = grade.id;
      gradeNote.textContent = grade.name;
      renderGrades();
      flash(`${grade.name} grade`);
      schedule();
    });
    gradeRow.appendChild(btn);
  }
}

function renderPanelList() {
  panelList.innerHTML = '';
  const n = panelCount();
  panelNote.textContent = String(n);
  for (let i = 0; i < n; i++) {
    const panel = state.panels[i];
    const row = document.createElement('div');
    row.className = `panel-row${i === state.selectedPanel ? ' on' : ''}`;

    const no = document.createElement('span');
    no.className = 'panel-no';
    no.textContent = `0${i + 1}`;

    const select = document.createElement('select');
    select.className = 'panel-src';
    select.setAttribute('aria-label', `Photo in panel ${i + 1}`);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— empty —';
    select.appendChild(empty);
    state.photos.forEach((photo, pi) => {
      const opt = document.createElement('option');
      opt.value = String(pi);
      opt.textContent = photo.label;
      select.appendChild(opt);
    });
    select.value = panel && panel.photo !== null ? String(panel.photo) : '';
    select.addEventListener('change', () => {
      if (select.value === '') removePhotoFrom(i);
      else assignPhoto(i, Number(select.value));
    });

    const acts = document.createElement('div');
    acts.className = 'panel-acts';
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'mini';
    swap.textContent = '↻';
    swap.title = 'Cycle to the next photo';
    swap.addEventListener('click', () => {
      if (!state.photos.length) return;
      const current = panel && panel.photo !== null ? panel.photo : -1;
      assignPhoto(i, (current + 1) % state.photos.length);
    });
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'mini';
    drop.textContent = '✕';
    drop.title = 'Remove this panel’s photo';
    drop.addEventListener('click', () => removePhotoFrom(i));
    acts.append(swap, drop);

    row.append(no, select, acts);
    row.addEventListener('pointerdown', (ev) => {
      if (ev.target === select) return;
      state.selectedPanel = i;
      syncZoomRow();
      renderPanelList();
    });
    panelList.appendChild(row);
  }
}

function renderTray() {
  trayList.innerHTML = '';
  photoNote.textContent = String(state.photos.length);
  state.photos.forEach((photo, index) => {
    const uses = usesOf(index);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `thumb${index === state.selectedPhoto ? ' on' : ''}${uses ? ' thumb-used' : ''}`;
    btn.dataset.uses = `${uses}`;
    btn.title = `${photo.label} — in ${uses} panel${uses === 1 ? '' : 's'}`;
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = photo.label;
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      state.selectedPhoto = index;
      if (state.selectedPanel >= 0) assignPhoto(state.selectedPanel, index);
      else {
        renderTray();
        schedule();
      }
    });
    trayList.appendChild(btn);
  });
}

function syncZoomRow() {
  const panel = state.panels[state.selectedPanel];
  const zoom = panel?.crop?.zoom ?? 1;
  panelZoom.value = String(Math.round(zoom * 100));
  panelZoomOut.textContent = `${zoom.toFixed(1)}×`;
  document.getElementById('resetCrop').disabled = !panel || (zoom === 1 && !panel.crop.nx && !panel.crop.ny);
}

function setZoom(zoom, anchor) {
  const panel = state.panels[state.selectedPanel];
  if (!panel || panel.photo === null) return;
  const photo = state.photos[panel.photo];
  if (!photo) return;
  const before = panel.crop.zoom;
  const clamped = Math.max(1, Math.min(4, zoom));
  panel.crop.zoom = clamped;
  if (anchor && before > 0) {
    const rect = panelRectPixels(state.selectedPanel);
    if (rect) {
      const fit = coverDrawRect(photo.img, rect.w, rect.h, { zoom: 1, nx: 0, ny: 0 });
      const edgeX = Math.max(1, fit.dw * clamped - rect.w);
      const edgeY = Math.max(1, fit.dh * clamped - rect.h);
      if (edgeX > 1) panel.crop.nx = clamp1(panel.crop.nx + ((anchor.u - 0.5) * rect.w * (clamped - before) * 2) / edgeX);
      if (edgeY > 1) panel.crop.ny = clamp1(panel.crop.ny + ((anchor.v - 0.5) * rect.h * (clamped - before) * 2) / edgeY);
    }
  }
  panel.crop.nx = clamp1(panel.crop.nx);
  panel.crop.ny = clamp1(panel.crop.ny);
  syncZoomRow();
  schedule();
}

function clamp1(v) {
  return Math.max(-1, Math.min(1, v));
}

/** The selected panel's rectangle in cover pixels. */
function panelRectPixels(index) {
  const { w, h } = coverSize(state.size);
  const layout = LAYOUTS.find((l) => l.id === state.layout) ?? LAYOUTS[0];
  const p = layout.panels[index];
  if (!p) return null;
  return { x: p.x * w, y: p.y * h, w: p.w * w, h: p.h * h };
}

// ---------------------------------------------------------------- pointer: pan a panel

let drag = null;

canvas.addEventListener('pointerdown', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const { w, h } = coverSize(state.size);
  const cx = ((ev.clientX - rect.left) / rect.width) * w;
  const cy = ((ev.clientY - rect.top) / rect.height) * h;
  const layout = LAYOUTS.find((l) => l.id === state.layout) ?? LAYOUTS[0];
  let hit = -1;
  layout.panels.forEach((p, i) => {
    if (cx >= p.x * w && cx <= (p.x + p.w) * w && cy >= p.y * h && cy <= (p.y + p.h) * h) hit = i;
  });
  if (hit < 0) return;
  state.selectedPanel = hit;
  syncZoomRow();
  renderPanelList();
  const panel = state.panels[hit];
  if (!panel || panel.photo === null) {
    if (state.photos.length) assignPhoto(hit, state.selectedPhoto % state.photos.length);
    return;
  }
  const panelRect = panelRectPixels(hit);
  const photo = state.photos[panel.photo];
  if (!panelRect || !photo) return;
  const fit = coverDrawRect(photo.img, panelRect.w, panelRect.h, panel.crop);
  drag = {
    index: hit,
    startX: ev.clientX,
    startY: ev.clientY,
    nx: panel.crop.nx ?? 0,
    ny: panel.crop.ny ?? 0,
    mx: Math.max(1, fit.mx),
    my: Math.max(1, fit.my),
    scale: w / rect.width,
  };
  canvas.classList.add('dragging');
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const panel = state.panels[drag.index];
  if (!panel) return;
  const dx = (ev.clientX - drag.startX) * drag.scale;
  const dy = (ev.clientY - drag.startY) * drag.scale;
  // Dragging the picture right moves the crop window left: the image follows the pointer.
  panel.crop.nx = clamp1(drag.nx - dx / drag.mx);
  panel.crop.ny = clamp1(drag.ny - dy / drag.my);
  schedule();
});

function endDrag(ev) {
  if (!drag) return;
  drag = null;
  canvas.classList.remove('dragging');
  try {
    canvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* the pointer was already released */
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  (ev) => {
    if (!state.panels.length) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const { w, h } = coverSize(state.size);
    const cx = ((ev.clientX - rect.left) / rect.width) * w;
    const cy = ((ev.clientY - rect.top) / rect.height) * h;
    const layout = LAYOUTS.find((l) => l.id === state.layout) ?? LAYOUTS[0];
    let hit = -1;
    layout.panels.forEach((p, i) => {
      if (cx >= p.x * w && cx <= (p.x + p.w) * w && cy >= p.y * h && cy <= (p.y + p.h) * h) hit = i;
    });
    if (hit < 0) return;
    if (hit !== state.selectedPanel) {
      state.selectedPanel = hit;
      renderPanelList();
    }
    const panel = state.panels[hit];
    const anchor = {
      u: (cx - layout.panels[hit].x * w) / (layout.panels[hit].w * w),
      v: (cy - layout.panels[hit].y * h) / (layout.panels[hit].h * h),
    };
    const step = Math.exp(-ev.deltaY * 0.0016);
    setZoom((panel?.crop.zoom ?? 1) * step, anchor);
  },
  { passive: false },
);

// ---------------------------------------------------------------- file picking and dropping

document.getElementById('addPhotos').addEventListener('click', () => filePicker.click());

filePicker.addEventListener('change', async () => {
  const files = [...(filePicker.files ?? [])];
  filePicker.value = '';
  await ingestFiles(files);
});

async function ingestFiles(files) {
  const images = files.filter((f) => /^image\//.test(f.type || '')).slice(0, 4);
  if (!images.length) {
    flash('Those files are not images.');
    return;
  }
  const added = [];
  for (const file of images) {
    const photo = await addPhotoFile(file);
    if (photo) added.push(photo);
  }
  if (!added.length) return;
  // Fill the selected panel first, then walk forward, so a fresh drop lands where it is wanted.
  const start = Math.max(0, state.selectedPanel);
  added.forEach((photo, i) => {
    const index = state.photos.indexOf(photo);
    const panelIndex = (start + i) % Math.max(1, state.panels.length);
    if (state.panels[panelIndex]) {
      state.panels[panelIndex].photo = index;
      state.panels[panelIndex].crop = { zoom: 1, nx: 0, ny: 0 };
    }
  });
  state.selectedPhoto = state.photos.indexOf(added[added.length - 1]);
  renderTray();
  renderPanelList();
  syncZoomRow();
  flash(added.length === 1 ? `Added ${added[0].label}` : `Added ${added.length} photos`);
  schedule();
}

let dragDepth = 0;
window.addEventListener('dragenter', (ev) => {
  if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
  dragDepth += 1;
  document.body.classList.add('dropping');
});

window.addEventListener('dragover', (ev) => {
  if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dropping');
});

window.addEventListener('drop', async (ev) => {
  if (!ev.dataTransfer) return;
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  await ingestFiles([...ev.dataTransfer.files]);
});

// ---------------------------------------------------------------- caption editing

/** The canvas draws everything but the line being edited; the field over it carries the caret. */
function beginEdit(kind) {
  state.editing = kind;
  schedule();
}

function endEdit(kind) {
  if (state.editing !== kind) return;
  state.editing = null;
  schedule();
}

for (const [el, kind, input] of [
  [capTitle, 'title', titleText],
  [capTag, 'tagline', taglineText],
]) {
  el.addEventListener('focus', () => {
    el.textContent = kind === 'title' ? state.title : state.tagline;
    beginEdit(kind);
  });
  el.addEventListener('input', () => {
    const value = el.textContent.replace(/\s+/g, ' ').slice(0, kind === 'title' ? 46 : 64);
    if (kind === 'title') state.title = value;
    else state.tagline = value;
    input.value = value;
    schedule();
  });
  el.addEventListener('blur', () => {
    endEdit(kind);
    renderCaptionControls();
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      el.blur();
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      el.textContent = kind === 'title' ? state.title : state.tagline;
      el.blur();
    }
  });
}

function renderCaptionControls() {
  titleText.value = state.title;
  taglineText.value = state.tagline;
  capTitle.textContent = state.title;
  capTag.textContent = state.tagline;
  titleScale.value = String(Math.round(state.titleScale * 100));
  titleScaleOut.textContent = `${Math.round(state.titleScale * 100)}%`;
  for (const btn of document.querySelectorAll('#titlePos .seg-btn')) {
    btn.classList.toggle('on', btn.dataset.pos === state.titlePos);
  }
}

titleText.addEventListener('input', () => {
  state.title = titleText.value.slice(0, 46);
  capTitle.textContent = state.title;
  if (state.editing === 'title') {
    /* the field keeps the caret while typing */
  }
  schedule();
});

taglineText.addEventListener('input', () => {
  state.tagline = taglineText.value.slice(0, 64);
  capTag.textContent = state.tagline;
  schedule();
});

titleScale.addEventListener('input', () => {
  state.titleScale = Number(titleScale.value) / 100;
  titleScaleOut.textContent = `${titleScale.value}%`;
  schedule();
});

document.getElementById('titlePos').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (!btn) return;
  state.titlePos = btn.dataset.pos;
  renderCaptionControls();
  schedule();
});

intensity.addEventListener('input', () => {
  state.intensity = Number(intensity.value) / 100;
  intensityOut.textContent = `${intensity.value}%`;
  schedule();
});

panelZoom.addEventListener('input', () => setZoom(Number(panelZoom.value) / 100, null));

document.getElementById('resetCrop').addEventListener('click', () => {
  const panel = state.panels[state.selectedPanel];
  if (!panel) return;
  panel.crop = { zoom: 1, nx: 0, ny: 0 };
  syncZoomRow();
  schedule();
});

// ---------------------------------------------------------------- post size

function renderSizes() {
  for (const btn of document.querySelectorAll('#sizes .chip')) {
    btn.classList.toggle('on', btn.dataset.size === state.size);
  }
  const { w, h } = coverSize(state.size);
  exportSize.textContent = `${w} × ${h}`;
}

document.getElementById('sizes').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn || btn.dataset.size === state.size) return;
  state.size = btn.dataset.size;
  renderSizes();
  schedule();
});

// ---------------------------------------------------------------- export

/** Paints a fresh full-size canvas through drawCover() and hands it to the browser as a PNG. */
function renderExportCanvas() {
  const { w, h } = coverSize(state.size);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  drawCover(out.getContext('2d'), w, h, {
    layout: state.layout,
    panels: state.panels,
    photos: state.photos,
    grade: state.grade,
    intensity: state.intensity,
    title: state.title,
    tagline: state.tagline,
    titlePos: state.titlePos,
    titleSize: state.titleScale,
    editing: null,
  });
  return { canvas: out, w, h };
}

function exportPng() {
  const { canvas: out, w, h } = renderExportCanvas();
  return new Promise((resolve) => {
    out.toBlob((blob) => {
      if (!blob) {
        flash('The browser could not encode the PNG.');
        resolve(null);
        return;
      }
      const name = `vice-cover-${w}x${h}.png`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      flash(`Saved ${name}`);
      resolve({ blob, name, w, h });
    }, 'image/png');
  });
}

document.getElementById('export').addEventListener('click', exportPng);
document.getElementById('export2').addEventListener('click', exportPng);

// ---------------------------------------------------------------- misc

let flashTimer = 0;
function flash(message) {
  statusEl.textContent = message;
  statusEl.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    statusEl.classList.remove('flash');
    statusEl.textContent = 'Drag a photo to pan · wheel to zoom · click a caption to edit it';
  }, 3200);
}

window.addEventListener('resize', schedule);

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    await document.fonts.load('40px "Anton"');
    await document.fonts.ready;
  } catch {
    /* the fallback stack still draws a poster face */
  }

  await Promise.all([addSample('boulevard', 'Boulevard'), addSample('pier', 'Pier')]);

  state.panels = [
    { photo: 0, crop: { zoom: 1, nx: 0, ny: 0 } },
    { photo: 1, crop: { zoom: 1, nx: 0, ny: 0 } },
    { photo: 0, crop: { zoom: 1.25, nx: 0.08, ny: -0.1 } },
  ];

  renderLayouts();
  renderGrades();
  renderPanelList();
  renderTray();
  renderCaptionControls();
  renderSizes();
  syncZoomRow();
  intensityOut.textContent = `${Math.round(state.intensity * 100)}%`;
  gradeNote.textContent = 'Sunset';
  paint();

  // Small, stable handles for the screenshot script and for anyone poking at it in the console.
  window.viceCover = {
    state,
    redraw: schedule,
    exportPng,
    renderExportCanvas,
    setLayout(id) {
      state.layout = id;
      resizePanels();
      renderLayouts();
      renderPanelList();
      syncZoomRow();
      schedule();
    },
    setGrade(id) {
      state.grade = id;
      gradeNote.textContent = (GRADES.find((g) => g.id === id) ?? GRADES[0]).name;
      renderGrades();
      schedule();
    },
    setSize(id) {
      state.size = id;
      renderSizes();
      schedule();
    },
    setTitle(text, tagline) {
      state.title = String(text ?? state.title);
      if (tagline !== undefined) state.tagline = String(tagline);
      renderCaptionControls();
      schedule();
    },
    setTitlePos(pos) {
      state.titlePos = pos;
      renderCaptionControls();
      schedule();
    },
    assign(panelIndex, photoIndex) {
      assignPhoto(panelIndex, photoIndex);
    },
    setIntensity(v) {
      state.intensity = Math.max(0, Math.min(1, v));
      intensity.value = String(Math.round(state.intensity * 100));
      intensityOut.textContent = `${Math.round(state.intensity * 100)}%`;
      schedule();
    },
    setTitleScale(v) {
      state.titleScale = Math.max(0.5, Math.min(1.5, v));
      renderCaptionControls();
      schedule();
    },
    async addFile(file) {
      const photo = await addPhotoFile(file);
      if (photo) {
        state.photos.push(state.photos.splice(state.photos.indexOf(photo), 1)[0]);
        state.selectedPhoto = state.photos.length - 1;
        if (state.panels[state.selectedPanel]) assignPhoto(state.selectedPanel, state.photos.length - 1);
        renderTray();
        schedule();
      }
      return photo;
    },
    ready: true,
  };
}

boot();
