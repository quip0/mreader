/* mreader — a minimal, mobile-first EPUB/PDF reader.
 * Books live in IndexedDB (blob + cover + metadata + last position). */

import ePub from "epubjs";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const el = (id) => document.getElementById(id);
const dom = {
  library: el("library"),
  bookGrid: el("book-grid"),
  libEmpty: el("lib-empty"),
  btnEdit: el("btn-edit"),
  fab: el("fab-add"),
  emptyAdd: el("empty-add"),
  fileInput: el("file-input"),

  reader: el("reader"),
  back: el("btn-back"),
  bookTitle: el("book-title"),
  viewport: el("viewport"),
  epubArea: el("epub-area"),
  pdfArea: el("pdf-area"),
  gestureLayer: el("gesture-layer"),
  loading: el("loading"),
  debugHud: el("debug-hud"),
  prev: el("btn-prev"),
  next: el("btn-next"),
  progressFill: el("progress-fill"),
  location: el("location"),
  fontInc: el("btn-font-inc"),
  fontDec: el("btn-font-dec"),
  theme: el("btn-theme"),
  toc: el("btn-toc"),
  tocPanel: el("toc-panel"),
  tocOverlay: el("toc-overlay"),
  tocList: el("toc-list"),
};

const state = {
  kind: null, // "epub" | "pdf"
  fontSize: Number(localStorage.getItem("mreader-font")) || 100,
  record: null, // active book record from IndexedDB
  book: null,
  rendition: null,
  pdf: null,
  pdfPage: 1,
  pdfScale: 1.4,
};

const THEMES = ["light", "sepia", "dark"];

/* ================= IndexedDB ================= */
const DB_NAME = "mreader";
const STORE = "books";
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const t = conn.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
const dbGetAll = () => tx("readonly", (s) => s.getAll());
const dbGet = (id) => tx("readonly", (s) => s.get(id));
const dbPut = (rec) => tx("readwrite", (s) => s.put(rec));
const dbDelete = (id) => tx("readwrite", (s) => s.delete(id));

/* ================= Theme ================= */
function loadTheme() {
  const saved = localStorage.getItem("mreader-theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  applyEpubTheme();
}
function cycleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("mreader-theme", next);
  applyEpubTheme();
}
function applyEpubTheme() {
  if (!state.rendition) return;
  const css = getComputedStyle(document.documentElement);
  state.rendition.themes.override("color", css.getPropertyValue("--fg").trim());
  state.rendition.themes.override("background", css.getPropertyValue("--bg").trim());
}

/* ================= Helpers ================= */
function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}
async function urlToDataURL(url) {
  try {
    const res = await fetch(url);
    return await blobToDataURL(await res.blob());
  } catch (e) {
    return null;
  }
}

/* ================= Metadata + cover extraction ================= */
async function extractEpubMeta(buffer) {
  const book = ePub(buffer);
  await book.ready;
  const md = book.package.metadata || {};
  let cover = null;
  try {
    const url = await book.coverUrl();
    if (url) cover = await urlToDataURL(url);
  } catch (e) { /* no cover */ }
  try { book.destroy(); } catch (e) {}
  return { title: md.title || "", author: md.creator || "", cover };
}

async function extractPdfMeta(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let title = "", author = "";
  try {
    const info = (await pdf.getMetadata()).info || {};
    title = info.Title || "";
    author = info.Author || "";
  } catch (e) {}
  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = 300 / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    cover = canvas.toDataURL("image/jpeg", 0.75);
  } catch (e) {}
  try { pdf.destroy(); } catch (e) {}
  return { title, author, cover };
}

/* ================= Adding / removing books ================= */
async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.(epub|pdf)$/i.test(f.name));
  if (!files.length) return;

  dom.fab.classList.add("busy");
  try {
    for (const file of files) {
      const kind = /\.epub$/i.test(file.name) ? "epub" : "pdf";
      const id = `${file.name}:${file.size}`;
      if (await dbGet(id)) continue; // already in the library

      let meta = { title: "", author: "", cover: null };
      try {
        // getDocument transfers (detaches) the buffer, so extract from a copy.
        const buf = await file.arrayBuffer();
        meta = kind === "epub"
          ? await extractEpubMeta(buf.slice(0))
          : await extractPdfMeta(buf.slice(0));
      } catch (e) { /* fall back to filename */ }

      await dbPut({
        id,
        kind,
        blob: file,
        size: file.size,
        title: meta.title || file.name.replace(/\.(epub|pdf)$/i, ""),
        author: meta.author || "",
        cover: meta.cover || null,
        addedAt: Date.now(),
        pos: null,
      });
    }
    await renderLibrary();
  } finally {
    dom.fab.classList.remove("busy");
    dom.fileInput.value = "";
  }
}

async function removeBook(record) {
  if (!confirm(`Remove “${record.title}” from your library?`)) return;
  await dbDelete(record.id);
  await renderLibrary();
}

/* ================= Library dashboard ================= */
async function renderLibrary() {
  const books = (await dbGetAll()).sort((a, b) => b.addedAt - a.addedAt);
  dom.bookGrid.innerHTML = "";

  const empty = books.length === 0;
  dom.libEmpty.classList.toggle("hidden", !empty);
  dom.bookGrid.classList.toggle("hidden", empty);
  dom.btnEdit.classList.toggle("hidden", empty);
  if (empty) dom.library.classList.remove("editing");

  for (const rec of books) {
    const card = document.createElement("div");
    card.className = "book-card";

    let cover;
    if (rec.cover) {
      cover = document.createElement("img");
      cover.className = "book-cover";
      cover.src = rec.cover;
      cover.alt = rec.title;
      cover.loading = "lazy";
    } else {
      cover = document.createElement("div");
      cover.className = "book-cover placeholder";
      cover.innerHTML =
        `<span class="ph-kind">${rec.kind.toUpperCase()}</span>` +
        `<span class="ph-title">${escapeHtml(rec.title)}</span>`;
    }
    card.appendChild(cover);

    const meta = document.createElement("div");
    meta.className = "book-meta";
    meta.innerHTML =
      `<div class="book-name">${escapeHtml(rec.title)}</div>` +
      (rec.author ? `<div class="book-author">${escapeHtml(rec.author)}</div>` : "");
    card.appendChild(meta);

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove");
    del.addEventListener("click", (e) => { e.stopPropagation(); removeBook(rec); });
    card.appendChild(del);

    card.addEventListener("click", () => {
      if (dom.library.classList.contains("editing")) return;
      openBook(rec);
    });
    dom.bookGrid.appendChild(card);
  }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function showLibrary() {
  teardown();
  dom.reader.classList.add("hidden");
  dom.library.classList.remove("hidden");
  renderLibrary();
}

/* ================= Opening a book ================= */
function showReader(title) {
  dom.library.classList.add("hidden");
  dom.reader.classList.remove("hidden");
  dom.reader.classList.remove("chrome-hidden");
  dom.bookTitle.textContent = title || "";
}
function setLoading(on) { dom.loading.classList.toggle("hidden", !on); }

function teardown() {
  if (state.rendition) { try { state.rendition.destroy(); } catch (e) {} }
  if (state.book) { try { state.book.destroy(); } catch (e) {} }
  state.book = state.rendition = state.pdf = state.record = null;
  state.kind = null;
  dom.epubArea.innerHTML = "";
  dom.epubArea.classList.add("hidden");
  dom.pdfArea.innerHTML = "";
  dom.pdfArea.classList.add("hidden");
  dom.gestureLayer.classList.add("hidden");
  clearToc();
  closeToc();
}

async function openBook(record) {
  teardown();
  state.record = record;
  state.kind = record.kind;
  showReader(record.title);
  setLoading(true);
  const buffer = await record.blob.arrayBuffer();
  if (record.kind === "epub") {
    // Overlay captures gestures above the iframe.
    dom.gestureLayer.classList.remove("hidden");
    renderEpub(buffer);
  } else {
    // PDF area is a normal scrollable element — listen on it directly so
    // vertical scrolling still works.
    renderPdf(buffer);
  }
}

function savePosition(value) {
  if (!state.record) return;
  state.record.pos = value;
  dbPut(state.record); // fire and forget
}

/* ================= EPUB ================= */
function renderEpub(buffer) {
  dom.epubArea.classList.remove("hidden");
  const book = ePub(buffer);
  state.book = book;

  const rendition = book.renderTo("epub-area", {
    width: "100%",
    height: "100%",
    spread: "none",
    flow: "paginated",
  });
  state.rendition = rendition;
  rendition.themes.fontSize(state.fontSize + "%");
  applyEpubTheme();

  // Gestures are captured by an overlay in THIS document (see openBook),
  // so they never depend on touch events crossing the iframe boundary.

  const saved = state.record && state.record.pos;
  rendition.display(saved && saved.cfi ? saved.cfi : undefined).then(() => setLoading(false));

  book.ready
    .then(() => book.locations.generate(1600))
    .then(updateEpubProgress);

  book.loaded.navigation.then((nav) => renderEpubToc(nav.toc));

  rendition.on("relocated", (loc) => {
    updateEpubProgress();
    if (loc && loc.start) savePosition({ cfi: loc.start.cfi });
  });
  rendition.on("keyup", onKey);
}

function updateEpubProgress() {
  const loc = state.rendition && state.rendition.currentLocation();
  if (!loc || !loc.start) return;
  const book = state.book;
  let pct = 0;
  if (book.locations && book.locations.length()) {
    pct = book.locations.percentageFromCfi(loc.start.cfi) || 0;
  }
  dom.progressFill.style.width = (pct * 100).toFixed(1) + "%";
  dom.location.textContent = Math.round(pct * 100) + "%";
}

/* ================= PDF ================= */
function renderPdf(buffer) {
  dom.pdfArea.classList.remove("hidden");
  pdfjsLib.getDocument({ data: buffer }).promise.then((pdf) => {
    state.pdf = pdf;
    const saved = state.record && state.record.pos;
    renderPdfPage(saved && saved.page ? saved.page : 1);
    pdf.getOutline().then(renderPdfToc);
  }).catch((err) => {
    setLoading(false);
    alert("Could not open PDF: " + err.message);
  });
}

function renderPdfPage(num) {
  const pdf = state.pdf;
  if (!pdf) return;
  num = Math.max(1, Math.min(num, pdf.numPages));
  state.pdfPage = num;

  pdf.getPage(num).then((page) => {
    const ratio = window.devicePixelRatio || 1;
    const containerW = dom.pdfArea.clientWidth || window.innerWidth;
    const base = page.getViewport({ scale: 1 });
    // Fit page width to the screen, then sharpen with device pixel ratio.
    const fit = Math.min(state.pdfScale, (containerW - 8) / base.width);
    const viewport = page.getViewport({ scale: fit * ratio });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width / ratio + "px";

    dom.pdfArea.innerHTML = "";
    dom.pdfArea.appendChild(canvas);
    dom.pdfArea.scrollTop = 0;

    page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise
      .then(() => setLoading(false));

    dom.progressFill.style.width = (num / pdf.numPages * 100).toFixed(1) + "%";
    dom.location.textContent = `${num} / ${pdf.numPages}`;
    savePosition({ page: num });
  });
}

/* ================= Navigation ================= */
function goPrev() {
  if (state.kind === "epub" && state.rendition) state.rendition.prev();
  else if (state.kind === "pdf") renderPdfPage(state.pdfPage - 1);
}
function goNext() {
  if (state.kind === "epub" && state.rendition) state.rendition.next();
  else if (state.kind === "pdf") renderPdfPage(state.pdfPage + 1);
}
function toggleChrome() {
  dom.reader.classList.toggle("chrome-hidden");
}

/* ================= Gestures (swipe + tap zones) ================= */
const DEBUG = location.hash.includes("debug");
function debugLog(msg) {
  if (!DEBUG) return;
  dom.debugHud.classList.remove("hidden");
  dom.debugHud.textContent = msg;
}

// Attach swipe + tap-zone handling to a DOM element.
function attachGestures(target) {
  let x0 = null, y0 = null, t0 = 0, tracking = false;

  const begin = (x, y) => { x0 = x; y0 = y; t0 = Date.now(); tracking = true; };
  const finish = (x, y) => {
    if (!tracking) return;
    tracking = false;
    const dx = x - x0, dy = y - y0;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    const dt = Date.now() - t0;
    debugLog(`dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} dt=${dt}ms`);

    if (adx > 40 && adx > ady * 1.3) {
      if (dx < 0) goNext(); else goPrev(); // swipe left = next
    } else if (adx < 12 && ady < 12 && dt < 350) {
      const w = window.innerWidth;
      if (x < w * 0.3) goPrev();
      else if (x > w * 0.7) goNext();
      else toggleChrome();
    }
  };

  target.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    debugLog("touchstart");
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  target.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    finish(t.clientX, t.clientY);
  }, { passive: true });
  target.addEventListener("touchcancel", () => { tracking = false; });

  // Mouse fallback so swipe/tap also work when testing on desktop.
  target.addEventListener("mousedown", (e) => begin(e.clientX, e.clientY));
  target.addEventListener("mouseup", (e) => finish(e.clientX, e.clientY));
}

/* ================= Font size (EPUB) ================= */
function changeFont(delta) {
  if (state.kind !== "epub" || !state.rendition) return;
  state.fontSize = Math.max(60, Math.min(240, state.fontSize + delta));
  localStorage.setItem("mreader-font", state.fontSize);
  state.rendition.themes.fontSize(state.fontSize + "%");
}

/* ================= Table of contents ================= */
function openToc() {
  dom.tocPanel.classList.remove("hidden");
  dom.tocOverlay.classList.remove("hidden");
}
function closeToc() {
  dom.tocPanel.classList.add("hidden");
  dom.tocOverlay.classList.add("hidden");
}
function clearToc() { dom.tocList.innerHTML = ""; }

function tocLink(label, depth, onClick) {
  const a = document.createElement("a");
  a.className = "toc-item";
  a.href = "#";
  a.textContent = (label || "").trim() || "Untitled";
  a.style.paddingLeft = 0.9 + depth * 0.9 + "rem";
  a.addEventListener("click", (e) => { e.preventDefault(); onClick(); closeToc(); });
  dom.tocList.appendChild(a);
}
function renderEpubToc(items) {
  clearToc();
  const build = (arr, depth) => arr.forEach((item) => {
    tocLink(item.label, depth, () => state.rendition.display(item.href));
    if (item.subitems && item.subitems.length) build(item.subitems, depth + 1);
  });
  build(items || [], 0);
  if (!dom.tocList.children.length)
    dom.tocList.innerHTML = '<div class="toc-empty">No table of contents</div>';
}
async function pdfDestToPage(dest) {
  try {
    let d = dest;
    if (typeof dest === "string") d = await state.pdf.getDestination(dest);
    if (!Array.isArray(d) || !d[0]) return null;
    return (await state.pdf.getPageIndex(d[0])) + 1;
  } catch (e) { return null; }
}
async function renderPdfToc(outline) {
  clearToc();
  if (outline && outline.length) {
    const build = (arr, depth) => arr.forEach((item) => {
      tocLink(item.title, depth, async () => {
        const page = await pdfDestToPage(item.dest);
        if (page) renderPdfPage(page);
      });
      if (item.items && item.items.length) build(item.items, depth + 1);
    });
    build(outline, 0);
  } else {
    for (let i = 1; i <= state.pdf.numPages; i++) {
      tocLink("Page " + i, 0, () => renderPdfPage(i));
    }
  }
}

/* ================= Keyboard ================= */
function onKey(e) {
  const k = e.key;
  if (k === "Escape") closeToc();
  else if (k === "ArrowLeft" || k === "PageUp") goPrev();
  else if (k === "ArrowRight" || k === "PageDown" || k === " ") goNext();
}

/* ================= Wiring ================= */
dom.fileInput.addEventListener("change", (e) => addFiles(e.target.files));
dom.fab.addEventListener("click", () => dom.fileInput.click());
dom.emptyAdd.addEventListener("click", () => dom.fileInput.click());
dom.btnEdit.addEventListener("click", () => {
  const editing = dom.library.classList.toggle("editing");
  dom.btnEdit.textContent = editing ? "Done" : "Edit";
});

dom.back.addEventListener("click", showLibrary);
dom.prev.addEventListener("click", goPrev);
dom.next.addEventListener("click", goNext);
dom.fontInc.addEventListener("click", () => changeFont(10));
dom.fontDec.addEventListener("click", () => changeFont(-10));
dom.theme.addEventListener("click", cycleTheme);
dom.toc.addEventListener("click", openToc);
dom.tocOverlay.addEventListener("click", closeToc);

// Persistent gesture surfaces — attach once (never per book, to avoid stacking
// duplicate listeners). EPUB uses the overlay; PDF listens on its scroll area.
attachGestures(dom.gestureLayer);
attachGestures(dom.pdfArea);

document.addEventListener("keyup", onKey);
window.addEventListener("resize", () => {
  if (state.kind === "pdf" && state.pdf) renderPdfPage(state.pdfPage);
});

// Drag & drop anywhere adds to the library.
["dragover", "drop"].forEach((type) =>
  document.addEventListener(type, (e) => e.preventDefault())
);
document.addEventListener("drop", (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) addFiles(files);
});

loadTheme();
renderLibrary();
