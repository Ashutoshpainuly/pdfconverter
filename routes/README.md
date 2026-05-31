# PDF Converter Pro — Fix Notes & API Reference

## Problem Fixed
`server.js` was importing `./routes/pdf` and `./routes/upload` but those files **did not exist**.
This caused ALL features to crash on startup (except compress, if it was handled inline).

## Files Added
- `routes/upload.js` — handles file uploads (single & multiple)
- `routes/pdf.js`   — all PDF operations (8 endpoints)

## Setup
```bash
npm install
node server.js
```

---

## API Endpoints

### Upload
| Method | URL | Body | Description |
|--------|-----|------|-------------|
| POST | `/api/upload/single` | `multipart: file` | Upload one file |
| POST | `/api/upload/multiple` | `multipart: files[]` | Upload multiple files |

### PDF Operations
| Method | URL | Body | Description |
|--------|-----|------|-------------|
| POST | `/api/pdf/merge` | `multipart: files[]` (≥2 PDFs) | Merge PDFs |
| POST | `/api/pdf/split` | `multipart: file` + `splitType`, `pageRanges`, `pagesPerPart` | Split PDF |
| POST | `/api/pdf/compress` | `multipart: file` + `quality` (low/medium/high) | Compress PDF |
| POST | `/api/pdf/to-images` | `multipart: file` + `dpi`, `format` | PDF → PNG/JPG zip *(needs Ghostscript)* |
| POST | `/api/pdf/images-to-pdf` | `multipart: files[]` (images) | Images → PDF |
| POST | `/api/pdf/to-word` | `multipart: file` | PDF → DOCX |
| POST | `/api/pdf/word-to-pdf` | `multipart: file` (.docx) | DOCX → PDF |
| POST | `/api/pdf/rotate` | `multipart: file` + `degrees`, `pages` | Rotate pages |
| POST | `/api/pdf/info` | `multipart: file` | Get PDF metadata |
| GET  | `/api/health` | — | Health check |

### Download
All converted files are served at: `/converted/<fileName>`

---

## Optional: Install pdf-parse for better Word conversion
```bash
npm install pdf-parse
```
This enables real text extraction when converting PDF → Word.

## Optional: Ghostscript for PDF → Images
```bash
# Ubuntu/Debian
sudo apt-get install ghostscript graphicsmagick

# macOS
brew install ghostscript graphicsmagick
```
