# mreader

A minimal, client-side reader for **EPUB** and **PDF**. No backend, no uploads — files are read entirely in the browser.

## Features

- 📖 EPUB (reflowable, paginated) and PDF rendering
- 🗂️ Table of contents (EPUB navigation / PDF outline, with page-list fallback)
- 📍 Remembers your last position per book (`localStorage`)
- 🔠 Adjustable font size (EPUB)
- 🎨 Light / sepia / dark themes
- ⌨️ Keyboard nav — `←` / `→`, Space, PageUp/Down, `Esc` to close panels
- 🖱️ Drag & drop a file anywhere to open it
- 📲 Installable PWA — works fully offline once loaded (app shell is
  cached by a service worker; books live in IndexedDB on the device)

## Development

```bash
npm install
npm run dev      # start Vite dev server (http://localhost:5173)
npm run build    # production build → dist/
npm run preview  # preview the production build
```

## Deploying to Vercel

The repo is a standard Vite project — Vercel auto-detects it:

- **Framework preset:** Vite
- **Build command:** `npm run build`
- **Output directory:** `dist`

Import the repo on Vercel and deploy; no extra configuration needed.

## Tech

- [epub.js](https://github.com/futurepress/epub.js) — EPUB rendering
- [pdf.js](https://github.com/mozilla/pdf.js) — PDF rendering
- [Vite](https://vitejs.dev) — dev server & bundler
