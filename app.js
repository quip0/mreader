/* mreader — a minimal EPUB/PDF reader
 * State is deliberately tiny: one active document at a time. */

import ePub from "epubjs";
import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to a hashed URL for the bundled worker.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const el = (id) => document.getElementById(id);

const dom = {
  landing: el("landing"),
  reader: el("reader"),
  fileInput: el("file-input"),
  bookTitle: el("book-title"),
  viewport: el("viewport"),
  epubArea: el("epub-area"),
  pdfArea: el("pdf-area"),
  prev: el("btn-prev"),
  next: el("btn-next"),
  progressFill: el("progress-fill"),
  location: el("location"),
  library: el("btn-library"),
  fontInc: el("btn-font-inc"),
  fontDec: el("btn-font-dec"),
  theme: el("btn-theme"),
  toc: el("btn-toc"),
  tocPanel: el("toc-panel"),
  tocOverlay: el("toc-overlay"),
  tocList: el("toc-list"),
};

// ---------- Shared reader state ----------
const state = {
  kind: null, // "epub" | "pdf"
  fontSize: 100, // percent, epub only
  bookId: null, // stable per-file key for saved position
  // epub
  book: null,
  rendition: null,
  // pdf
  pdf: null,
  pdfPage: 1,
  pdfScale: 1.3,
};

const THEMES = ["light", "sepia", "dark"];

// ---------- Theme & persistence ----------
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

// Mirror the page theme into the epub iframe (it has its own document).
function applyEpubTheme() {
  if (!state.rendition) return;
  const css = getComputedStyle(document.documentElement);
  state.rendition.themes.override("color", css.getPropertyValue("--fg").trim());
  state.rendition.themes.override("background", css.getPropertyValue("--bg").trim());
}

// ---------- Position persistence ----------
// Key each book by name + byte size — cheap and stable enough for local files.
function bookIdFor(file) {
  return `${file.name}:${file.size}`;
}
function savePosition(value) {
  if (state.bookId) localStorage.setItem("mreader-pos:" + state.bookId, JSON.stringify(value));
}
function loadPosition() {
  if (!state.bookId) return null;
  const raw = localStorage.getItem("mreader-pos:" + state.bookId);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// ---------- Table of contents ----------
function openToc() {
  dom.tocPanel.classList.remove("hidden");
  dom.tocOverlay.classList.remove("hidden");
}
function closeToc() {
  dom.tocPanel.classList.add("hidden");
  dom.tocOverlay.classList.add("hidden");
}
function clearToc() {
  dom.tocList.innerHTML = "";
}

function tocLink(label, depth, onClick) {
  const a = document.createElement("a");
  a.className = "toc-item";
  a.href = "#";
  a.textContent = (label || "").trim() || "Untitled";
  a.style.paddingLeft = 0.75 + depth * 0.85 + "rem";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
    closeToc();
  });
  dom.tocList.appendChild(a);
  return a;
}

function renderEpubToc(items) {
  clearToc();
  const build = (arr, depth) => {
    arr.forEach((item) => {
      tocLink(item.label, depth, () => state.rendition.display(item.href));
      if (item.subitems && item.subitems.length) build(item.subitems, depth + 1);
    });
  };
  build(items || [], 0);
  if (!dom.tocList.children.length) {
    dom.tocList.innerHTML = '<div class="toc-empty">No table of contents</div>';
  }
}

// Resolve a PDF outline destination (named or explicit) to a 1-based page number.
async function pdfDestToPage(dest) {
  try {
    let d = dest;
    if (typeof dest === "string") d = await state.pdf.getDestination(dest);
    if (!Array.isArray(d) || !d[0]) return null;
    return (await state.pdf.getPageIndex(d[0])) + 1;
  } catch (e) {
    return null;
  }
}

async function renderPdfToc(outline) {
  clearToc();
  if (outline && outline.length) {
    const build = (arr, depth) => {
      arr.forEach((item) => {
        tocLink(item.title, depth, async () => {
          const page = await pdfDestToPage(item.dest);
          if (page) renderPdfPage(page);
        });
        if (item.items && item.items.length) build(item.items, depth + 1);
      });
    };
    build(outline, 0);
  } else {
    // No embedded outline — fall back to a flat page list.
    for (let i = 1; i <= state.pdf.numPages; i++) {
      tocLink("Page " + i, 0, () => renderPdfPage(i));
    }
  }
}

// ---------- File loading ----------
function openFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith(".epub")) {
    loadEpub(file);
  } else if (name.endsWith(".pdf")) {
    loadPdf(file);
  } else {
    alert("Unsupported file — please choose an .epub or .pdf");
  }
}

function showReader(title) {
  dom.landing.classList.add("hidden");
  dom.reader.classList.remove("hidden");
  dom.bookTitle.textContent = title || "";
}

function teardown() {
  if (state.rendition) { try { state.rendition.destroy(); } catch (e) {} }
  if (state.book) { try { state.book.destroy(); } catch (e) {} }
  state.book = state.rendition = state.pdf = null;
  state.bookId = null;
  dom.epubArea.innerHTML = "";
  dom.epubArea.classList.add("hidden");
  dom.pdfArea.innerHTML = "";
  dom.pdfArea.classList.add("hidden");
  clearToc();
  closeToc();
}

// ---------- EPUB ----------
function loadEpub(file) {
  teardown();
  state.kind = "epub";
  state.bookId = bookIdFor(file);
  dom.epubArea.classList.remove("hidden");

  const reader = new FileReader();
  reader.onload = (e) => {
    const book = ePub(e.target.result);
    state.book = book;

    const rendition = book.renderTo("epub-area", {
      width: "100%",
      height: "100%",
      spread: "auto",
      flow: "paginated",
    });
    state.rendition = rendition;

    rendition.themes.fontSize(state.fontSize + "%");
    applyEpubTheme();

    // Restore the saved location (CFI) if we have one.
    const saved = loadPosition();
    rendition.display(saved && saved.cfi ? saved.cfi : undefined);

    book.ready.then(() => {
      showReader(book.package.metadata.title || file.name);
      return book.locations.generate(1600);
    }).then(() => {
      updateEpubProgress();
    });

    book.loaded.navigation.then((nav) => renderEpubToc(nav.toc));

    rendition.on("relocated", (loc) => {
      updateEpubProgress();
      if (loc && loc.start) savePosition({ cfi: loc.start.cfi });
    });
    // Forward keyboard/click inside the iframe up to our handlers
    rendition.on("keyup", onKey);
  };
  reader.readAsArrayBuffer(file);
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
  const page = loc.start.displayed;
  dom.location.textContent = page ? `${Math.round(pct * 100)}%` : "";
}

// ---------- PDF ----------
function loadPdf(file) {
  teardown();
  state.kind = "pdf";
  state.pdfPage = 1;
  state.bookId = bookIdFor(file);
  dom.pdfArea.classList.remove("hidden");

  const reader = new FileReader();
  reader.onload = (e) => {
    pdfjsLib.getDocument({ data: e.target.result }).promise.then((pdf) => {
      state.pdf = pdf;
      showReader(file.name.replace(/\.pdf$/i, ""));
      const saved = loadPosition();
      renderPdfPage(saved && saved.page ? saved.page : 1);
      pdf.getOutline().then(renderPdfToc);
    }).catch((err) => {
      alert("Could not open PDF: " + err.message);
    });
  };
  reader.readAsArrayBuffer(file);
}

function renderPdfPage(num) {
  const pdf = state.pdf;
  if (!pdf) return;
  num = Math.max(1, Math.min(num, pdf.numPages));
  state.pdfPage = num;

  pdf.getPage(num).then((page) => {
    const viewport = page.getViewport({ scale: state.pdfScale * (window.devicePixelRatio || 1) });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width / (window.devicePixelRatio || 1) + "px";

    dom.pdfArea.innerHTML = "";
    dom.pdfArea.appendChild(canvas);
    dom.pdfArea.scrollTop = 0;

    page.render({ canvasContext: ctx, viewport });

    dom.progressFill.style.width = (num / pdf.numPages * 100).toFixed(1) + "%";
    dom.location.textContent = `${num} / ${pdf.numPages}`;
    savePosition({ page: num });
  });
}

// ---------- Navigation ----------
function goPrev() {
  if (state.kind === "epub" && state.rendition) state.rendition.prev();
  else if (state.kind === "pdf") renderPdfPage(state.pdfPage - 1);
}
function goNext() {
  if (state.kind === "epub" && state.rendition) state.rendition.next();
  else if (state.kind === "pdf") renderPdfPage(state.pdfPage + 1);
}

// ---------- Font size (epub) ----------
function changeFont(delta) {
  if (state.kind !== "epub" || !state.rendition) return;
  state.fontSize = Math.max(60, Math.min(220, state.fontSize + delta));
  state.rendition.themes.fontSize(state.fontSize + "%");
}

// ---------- Keyboard ----------
function onKey(e) {
  const k = e.key;
  if (k === "Escape") closeToc();
  else if (k === "ArrowLeft" || k === "PageUp") goPrev();
  else if (k === "ArrowRight" || k === "PageDown" || k === " ") goNext();
}

// ---------- Wiring ----------
dom.fileInput.addEventListener("change", (e) => openFile(e.target.files[0]));
dom.prev.addEventListener("click", goPrev);
dom.next.addEventListener("click", goNext);
dom.fontInc.addEventListener("click", () => changeFont(10));
dom.fontDec.addEventListener("click", () => changeFont(-10));
dom.theme.addEventListener("click", cycleTheme);
dom.toc.addEventListener("click", openToc);
dom.tocOverlay.addEventListener("click", closeToc);
dom.library.addEventListener("click", () => {
  teardown();
  dom.reader.classList.add("hidden");
  dom.landing.classList.remove("hidden");
  dom.fileInput.value = "";
});
document.addEventListener("keyup", onKey);

// Drag & drop anywhere
["dragover", "drop"].forEach((type) =>
  document.addEventListener(type, (e) => e.preventDefault())
);
document.addEventListener("dragover", () => dom.landing.classList.add("dragover"));
document.addEventListener("dragleave", () => dom.landing.classList.remove("dragover"));
document.addEventListener("drop", (e) => {
  dom.landing.classList.remove("dragover");
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) openFile(file);
});

loadTheme();
