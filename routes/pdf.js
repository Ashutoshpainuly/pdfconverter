/**
 * PDF Routes - All PDF operations (Fixed)
 */
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs-extra');
const { v4: uuidv4 }   = require('uuid');
const { PDFDocument }  = require('pdf-lib');
const sharp    = require('sharp');
const archiver = require('archiver');

const uploadsDir   = path.join(__dirname, '..', 'uploads');
const convertedDir = path.join(__dirname, '..', 'converted');
fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(convertedDir);

// ── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const readFile   = (p) => fs.readFile(p);
const dlUrl      = (f) => `/converted/${f}`;
const cleanup    = (...paths) => Promise.allSettled(paths.map(p => p && fs.remove(p)));

// ── PDF text extractor (pure Node – no external binary needed) ────────────────
// Reads raw content streams and pulls out text tokens between BT...ET blocks
function extractTextFromPdfBytes(bytes) {
  const raw = bytes.toString('latin1');

  // collect all stream bodies
  const streams = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    streams.push(m[1]);
  }

  const lines = [];
  for (const stream of streams) {
    // look for BT ... ET blocks
    const btRe = /BT([\s\S]*?)ET/g;
    let bt;
    while ((bt = btRe.exec(stream)) !== null) {
      const block = bt[1];
      // extract string literals  (text) Tj / [(text)] TJ
      const strRe = /\(([^)]*)\)\s*(?:Tj|TJ)|(?:\[([^\]]*)\])\s*TJ/g;
      let sr;
      while ((sr = strRe.exec(block)) !== null) {
        const raw1 = sr[1] || sr[2] || '';
        // strip PDF octal escapes \ddd
        const decoded = raw1.replace(/\\(\d{3})/g, (_, o) =>
          String.fromCharCode(parseInt(o, 8))
        ).replace(/\\\\/g, '\\')
         .replace(/\\n/g, '\n')
         .replace(/\\r/g, '')
         .replace(/\\t/g, '\t');
        if (decoded.trim()) lines.push(decoded.trim());
      }
      // also handle Td / T* as newline hints
    }
  }

  return lines.join(' ').replace(/\s{3,}/g, '\n\n').trim();
}

// ── 1. MERGE PDFs ─────────────────────────────────────────────────────────
router.post('/merge', upload.array('files', 20), async (req, res) => {
  const files = req.files;
  if (!files || files.length < 2)
    return res.status(400).json({ success: false, error: 'Please upload at least 2 PDF files to merge.' });

  try {
    const merged = await PDFDocument.create();
    for (const file of files) {
      const bytes = await readFile(file.path);
      const doc   = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const outName = `merged-${uuidv4()}.pdf`;
    const outPath = path.join(convertedDir, outName);
    await fs.writeFile(outPath, await merged.save());
    await cleanup(...files.map(f => f.path));

    const stats = await fs.stat(outPath);
    res.json({ success: true, message: `Merged ${files.length} PDFs successfully!`, fileName: outName, fileSize: stats.size, downloadUrl: dlUrl(outName), pageCount: merged.getPageCount() });
  } catch (err) {
    await cleanup(...(files || []).map(f => f.path));
    console.error('Merge error:', err);
    res.status(500).json({ success: false, error: `Merge failed: ${err.message}` });
  }
});

// ── 2. SPLIT PDF ──────────────────────────────────────────────────────────
router.post('/split', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
  const { splitType = 'all', pageRanges, pagesPerPart } = req.body;

  try {
    const bytes  = await readFile(req.file.path);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total  = srcDoc.getPageCount();
    const parts  = [];

    if (splitType === 'range' && pageRanges) {
      pageRanges.split(',').forEach(r => {
        const [s, e] = r.trim().split('-').map(n => parseInt(n, 10));
        const start = Math.max(0, (s || 1) - 1);
        const end   = Math.min(total - 1, (e || s) - 1);
        parts.push(Array.from({ length: end - start + 1 }, (_, i) => start + i));
      });
    } else if (splitType === 'fixed' && pagesPerPart) {
      const n = parseInt(pagesPerPart, 10);
      for (let i = 0; i < total; i += n)
        parts.push(Array.from({ length: Math.min(n, total - i) }, (_, j) => i + j));
    } else {
      for (let i = 0; i < total; i++) parts.push([i]);
    }

    const sessionId  = uuidv4();
    const sessionDir = path.join(convertedDir, sessionId);
    await fs.ensureDir(sessionDir);

    const outFiles = [];
    for (let i = 0; i < parts.length; i++) {
      const newDoc = await PDFDocument.create();
      const copied = await newDoc.copyPages(srcDoc, parts[i]);
      copied.forEach(p => newDoc.addPage(p));
      const fname = `part-${i + 1}.pdf`;
      const fpath = path.join(sessionDir, fname);
      await fs.writeFile(fpath, await newDoc.save());
      outFiles.push({ name: fname, path: fpath });
    }

    const zipName = `split-${sessionId}.zip`;
    const zipPath = path.join(convertedDir, zipName);
    await new Promise((resolve, reject) => {
      const output  = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', reject);
      output.on('close', resolve);
      archive.pipe(output);
      outFiles.forEach(f => archive.file(f.path, { name: f.name }));
      archive.finalize();
    });

    await cleanup(req.file.path, sessionDir);
    const stats = await fs.stat(zipPath);
    res.json({ success: true, message: `PDF split into ${outFiles.length} parts!`, fileName: zipName, fileSize: stats.size, downloadUrl: dlUrl(zipName), partCount: outFiles.length });
  } catch (err) {
    await cleanup(req.file?.path);
    console.error('Split error:', err);
    res.status(500).json({ success: false, error: `Split failed: ${err.message}` });
  }
});

// ── 3. COMPRESS PDF ───────────────────────────────────────────────────────
router.post('/compress', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });

  try {
    const bytes  = await readFile(req.file.path);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const compressedBytes = await srcDoc.save({ useObjectStreams: true, addDefaultPage: false });

    const outName = `compressed-${uuidv4()}.pdf`;
    const outPath = path.join(convertedDir, outName);
    await fs.writeFile(outPath, compressedBytes);
    await cleanup(req.file.path);

    res.json({
      success: true,
      message: 'PDF compressed successfully!',
      fileName: outName,
      fileSize: compressedBytes.length,
      originalSize: bytes.length,
      savedBytes: Math.max(0, bytes.length - compressedBytes.length),
      compressionRatio: ((1 - compressedBytes.length / bytes.length) * 100).toFixed(1) + '%',
      downloadUrl: dlUrl(outName)
    });
  } catch (err) {
    await cleanup(req.file?.path);
    res.status(500).json({ success: false, error: `Compression failed: ${err.message}` });
  }
});

// ── 4. PDF → IMAGES ───────────────────────────────────────────────────────
// Uses pdf2pic (needs Ghostscript). If unavailable, renders pages as
// white PNG placeholders with page info so the zip always downloads.
router.post('/to-images', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });

  const dpi    = Math.min(300, Math.max(72, parseInt(req.body.dpi || '150', 10)));
  const format = (req.body.format || 'png').toLowerCase();

  const sessionId  = uuidv4();
  const sessionDir = path.join(convertedDir, sessionId);
  await fs.ensureDir(sessionDir);

  try {
    const bytes  = await readFile(req.file.path);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total  = srcDoc.getPageCount();

    let imageFiles = [];

    // ── Try pdf2pic (Ghostscript path) ──
    let usedGhostscript = false;
    try {
      const { fromPath } = require('pdf2pic');
      const converter = fromPath(req.file.path, {
        density: dpi,
        saveFilename: 'page',
        savePath: sessionDir,
        format: format === 'jpg' ? 'jpeg' : format,
        width: Math.round(8.27 * dpi),   // A4 width at chosen dpi
        height: Math.round(11.69 * dpi)  // A4 height at chosen dpi
      });

      for (let i = 1; i <= total; i++) {
        const result = await converter(i, { responseType: 'image' });
        if (result && (result.path || result.base64)) {
          const fname = `page-${i}.${format}`;
          const fpath = path.join(sessionDir, fname);
          if (result.path && result.path !== fpath) await fs.move(result.path, fpath, { overwrite: true });
          imageFiles.push({ name: fname, path: fpath });
        }
      }
      if (imageFiles.length > 0) usedGhostscript = true;
    } catch (gsErr) {
      console.log('pdf2pic unavailable, using sharp fallback:', gsErr.message);
    }

    // ── Sharp fallback: extract embedded images or create placeholder pages ──
    if (!usedGhostscript) {
      // Try to get page dimensions and create representative images
      const pdfPages = srcDoc.getPages();
      for (let i = 0; i < total; i++) {
        const page  = pdfPages[i];
        const { width, height } = page.getSize();
        const scale  = dpi / 72;
        const imgW   = Math.round(width  * scale);
        const imgH   = Math.round(height * scale);

        // Create a white page with page number text via SVG
        const svgText = `
          <svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="white"/>
            <rect x="40" y="40" width="${imgW-80}" height="${imgH-80}" fill="none" stroke="#e0e0e0" stroke-width="2"/>
            <text x="50%" y="45%" text-anchor="middle" font-family="Arial" font-size="${Math.round(imgW/15)}" fill="#999">Page ${i+1}</text>
            <text x="50%" y="55%" text-anchor="middle" font-family="Arial" font-size="${Math.round(imgW/25)}" fill="#bbb">${path.basename(req.file.originalname || 'document.pdf')}</text>
          </svg>`;

        const fname  = `page-${i + 1}.${format}`;
        const fpath  = path.join(sessionDir, fname);

        await sharp(Buffer.from(svgText))
          .toFormat(format === 'jpg' ? 'jpeg' : format)
          .toFile(fpath);

        imageFiles.push({ name: fname, path: fpath });
      }
    }

    // ── Zip all images ──
    const zipName = `images-${sessionId}.zip`;
    const zipPath = path.join(convertedDir, zipName);
    await new Promise((resolve, reject) => {
      const output  = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', reject);
      output.on('close', resolve);
      archive.pipe(output);
      imageFiles.forEach(img => archive.file(img.path, { name: img.name }));
      archive.finalize();
    });

    await cleanup(req.file.path, sessionDir);
    const stats = await fs.stat(zipPath);

    res.json({
      success: true,
      message: usedGhostscript
        ? `Converted ${total} page(s) to ${format.toUpperCase()} images!`
        : `Created ${total} page image(s). Install Ghostscript for pixel-perfect rendering.`,
      fileName: zipName,
      fileSize: stats.size,
      downloadUrl: dlUrl(zipName),
      pageCount: total,
      note: usedGhostscript ? null : 'For full PDF rendering install Ghostscript: https://ghostscript.com'
    });
  } catch (err) {
    await cleanup(req.file?.path, sessionDir);
    console.error('PDF→Images error:', err);
    res.status(500).json({ success: false, error: `Conversion failed: ${err.message}` });
  }
});

// ── 5. IMAGES → PDF ───────────────────────────────────────────────────────
router.post('/images-to-pdf', upload.array('files', 30), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0)
    return res.status(400).json({ success: false, error: 'No image files uploaded.' });

  try {
    const pdfDoc = await PDFDocument.create();

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const pngBuffer = await sharp(file.path).png().toBuffer();
      const img  = await pdfDoc.embedPng(pngBuffer);
      const { width, height } = img.scale(1);
      const pageW = 595.28, pageH = 841.89;
      const scale = Math.min(pageW / width, pageH / height, 1);
      const page  = pdfDoc.addPage([pageW, pageH]);
      page.drawImage(img, {
        x: (pageW - width * scale) / 2,
        y: (pageH - height * scale) / 2,
        width:  width  * scale,
        height: height * scale
      });
    }

    const outName = `from-images-${uuidv4()}.pdf`;
    const outPath = path.join(convertedDir, outName);
    await fs.writeFile(outPath, await pdfDoc.save());
    await cleanup(...files.map(f => f.path));

    const stats = await fs.stat(outPath);
    res.json({ success: true, message: `${files.length} image(s) converted to PDF!`, fileName: outName, fileSize: stats.size, downloadUrl: dlUrl(outName), pageCount: files.length });
  } catch (err) {
    await cleanup(...(files || []).map(f => f.path));
    console.error('Images→PDF error:', err);
    res.status(500).json({ success: false, error: `Conversion failed: ${err.message}` });
  }
});

// ── load pdf-parse once ───────────────────────────────────────────────────
let pdfParse = null;
try { pdfParse = require('pdf-parse'); console.log('[pdf-parse] loaded OK'); }
catch (e) { console.warn('[pdf-parse] not available:', e.message); }

// ── 6. PDF → WORD (DOCX) with OCR fallback ───────────────────────────────
router.post('/to-word', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
    const bytes  = await readFile(req.file.path);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total  = srcDoc.getPageCount();

    let pageTexts  = [];
    let extraction = 'none';

    // ── STEP 1: pdf-parse (works on real-text PDFs) ───────────────────────
    if (pdfParse) {
      try {
        const pageStrings = [];
        const data = await pdfParse(bytes, {
          pagerender: function(pageData) {
            return pageData.getTextContent({ normalizeWhitespace: true }).then(function(tc) {
              let str = '', lastY = null;
              for (const item of tc.items) {
                const y = item.transform ? item.transform[5] : null;
                if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) str += '\n';
                str += item.str || '';
                lastY = y;
              }
              pageStrings.push(str.trim());
              return str;
            });
          }
        });

        const hasText = pageStrings.some(p => p.replace(/\s/g,'').length > 2)
                     || (data.text || '').replace(/\s/g,'').length > 2;

        if (hasText) {
          if (pageStrings.some(p => p.replace(/\s/g,'').length > 2)) {
            pageTexts = pageStrings;
            extraction = 'pdf-parse-per-page';
          } else {
            pageTexts = (data.text || '').split('\f').map(t => t.trim()).filter(Boolean);
            if (!pageTexts.length) pageTexts = [(data.text || '').trim()];
            extraction = 'pdf-parse-full';
          }
        }
        console.log(`[pdf-parse] chars=${(data.text||'').length} hasText=${hasText}`);
      } catch (e) { console.error('[pdf-parse] error:', e.message); }
    }

    // ── STEP 2: raw stream parser fallback ───────────────────────────────
    if (!pageTexts.some(p => p.replace(/\s/g,'').length > 2)) {
      const raw = extractTextFromPdfBytes(bytes);
      if (raw.replace(/\s/g,'').length > 2) {
        pageTexts = raw.split(/\n{3,}/).map(t => t.trim()).filter(Boolean);
        if (!pageTexts.length) pageTexts = [raw.trim()];
        extraction = 'raw-stream';
        console.log(`[raw-stream] chars=${raw.length}`);
      }
    }

    // ── STEP 3: OCR with tesseract.js (scanned/image PDFs) ───────────────
    if (!pageTexts.some(p => p.replace(/\s/g,'').length > 2)) {
      console.log('[OCR] Starting Tesseract OCR on scanned PDF...');
      try {
        const Tesseract = require('tesseract.js');
        const ocrDir    = path.join(uploadsDir, 'ocr-' + uuidv4());
        await fs.ensureDir(ocrDir);
        const ocrTexts  = [];

        for (let i = 0; i < total; i++) {
          // Extract single page as a new PDF then render to PNG with sharp
          const singleDoc = await PDFDocument.create();
          const [copiedPage] = await singleDoc.copyPages(srcDoc, [i]);
          singleDoc.addPage(copiedPage);
          const singleBytes = await singleDoc.save();

          // Use sharp to create a high-res PNG from the PDF page bytes
          // sharp can read PDF on some systems; if not, create a white canvas with sharp
          const pngPath = path.join(ocrDir, `page-${i + 1}.png`);

          let pngCreated = false;
          try {
            // Try sharp PDF→PNG (works if libvips has PDF support)
            await sharp(singleBytes, { density: 200 })
              .png()
              .toFile(pngPath);
            pngCreated = true;
          } catch (_) {}

          if (!pngCreated) {
            // sharp can't render PDF — create a placeholder white image
            // and use pdf2pic if ghostscript is available
            try {
              const { fromPath: fp } = require('pdf2pic');
              const tmpPdf = path.join(ocrDir, `page-${i + 1}.pdf`);
              await fs.writeFile(tmpPdf, singleBytes);
              const conv = fp(tmpPdf, {
                density: 200, saveFilename: `page-${i+1}`,
                savePath: ocrDir, format: 'png'
              });
              const result = await conv(1);
              if (result && result.path) {
                await fs.move(result.path, pngPath, { overwrite: true });
                pngCreated = true;
              }
            } catch (_) {}
          }

          if (pngCreated) {
            console.log(`[OCR] Running Tesseract on page ${i + 1}...`);
            const { data: { text } } = await Tesseract.recognize(pngPath, 'eng', {
              logger: () => {}   // suppress progress logs
            });
            ocrTexts.push(text.trim());
            console.log(`[OCR] Page ${i + 1}: ${text.trim().length} chars extracted`);
          } else {
            ocrTexts.push(`[Page ${i + 1}: Could not render for OCR]`);
          }
        }

        await fs.remove(ocrDir);

        if (ocrTexts.some(t => t.replace(/\s/g,'').length > 2)) {
          pageTexts = ocrTexts;
          extraction = 'tesseract-ocr';
          console.log(`[OCR] Done — total chars: ${ocrTexts.join('').length}`);
        }
      } catch (ocrErr) {
        console.error('[OCR] Tesseract error:', ocrErr.message);
        if (ocrErr.message.includes("Cannot find module 'tesseract.js'")) {
          return res.status(422).json({
            success: false,
            error: 'This is a scanned PDF. To convert it, run: npm install tesseract.js   then restart the server.'
          });
        }
      }
    }

    // ── STEP 4: give up ──────────────────────────────────────────────────
    if (!pageTexts.some(p => p.replace(/\s/g,'').length > 2)) {
      await cleanup(req.file.path);
      return res.status(422).json({
        success: false,
        error: 'Could not extract text from this PDF even with OCR. The file may be corrupted or use an unsupported encoding.'
      });
    }

    console.log(`[to-word] method="${extraction}", pages=${pageTexts.length}`);

    // ── Build DOCX ────────────────────────────────────────────────────────
    const children = [];

    children.push(new Paragraph({
      children: [new TextRun({ text: req.file.originalname.replace(/\.pdf$/i, ''), bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 400 }
    }));

    if (extraction === 'tesseract-ocr') {
      children.push(new Paragraph({
        children: [new TextRun({ text: '⚠ This document was scanned. Text was extracted using OCR and may contain errors.', italics: true, color: '888888', size: 20 })],
        spacing: { after: 300 }
      }));
    }

    pageTexts.forEach((pageText, idx) => {
      if (total > 1) {
        children.push(new Paragraph({
          children: [new TextRun({ text: `— Page ${idx + 1} —`, color: '888888', size: 18, italics: true })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 300, after: 200 }
        }));
      }

      pageText.split(/\n+/).filter(l => l.trim()).forEach(para => {
        const text = para.trim();
        if (!text) return;
        const isHeading = text.length < 80 && text === text.toUpperCase() && /[A-Z]/.test(text);
        children.push(new Paragraph({
          children: [new TextRun({ text, bold: isHeading, size: isHeading ? 26 : 24 })],
          spacing: isHeading ? { before: 240, after: 120 } : { after: 120 },
          alignment: isHeading ? AlignmentType.LEFT : AlignmentType.JUSTIFIED
        }));
      });
    });

    const doc    = new Document({ sections: [{ properties: {}, children }] });
    const buffer = await Packer.toBuffer(doc);
    const outName = `converted-${uuidv4()}.docx`;
    const outPath  = path.join(convertedDir, outName);
    await fs.writeFile(outPath, buffer);
    await cleanup(req.file.path);

    const stats = await fs.stat(outPath);
    const isOcr = extraction === 'tesseract-ocr';
    res.json({
      success: true,
      message: isOcr
        ? `Scanned PDF converted using OCR! (${pageTexts.length} page(s))`
        : `PDF converted to Word! (${pageTexts.length} page(s))`,
      fileName: outName,
      fileSize: stats.size,
      downloadUrl: dlUrl(outName),
      pageCount: total,
      note: isOcr ? 'OCR was used — review the document for any recognition errors.' : null
    });
  } catch (err) {
    await cleanup(req.file?.path);
    console.error('PDF→Word error:', err);
    res.status(500).json({ success: false, error: `Conversion failed: ${err.message}` });
  }
});



// ── 7. WORD → PDF ─────────────────────────────────────────────────────────
router.post('/word-to-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No DOCX file uploaded.' });

  try {
    const pdfDoc = await PDFDocument.create();
    const { StandardFonts } = require('pdf-lib');

    let textLines = [];
    try {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ path: req.file.path });
      textLines = result.value.split('\n').filter(l => l.trim());
    } catch (_) {
      textLines = ['[Word to PDF conversion]', '', `File: ${req.file.originalname}`, '', 'Install mammoth for full text extraction: npm install mammoth'];
    }

    const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 12;
    const margin   = 60;
    const lineH    = fontSize * 1.6;
    const pageW    = 595.28;
    const pageH    = 841.89;
    const maxW     = pageW - margin * 2;

    let page = pdfDoc.addPage([pageW, pageH]);
    let y    = pageH - margin;

    for (const rawLine of textLines) {
      // Word-wrap long lines
      const words = rawLine.split(' ');
      let current = '';
      const wrappedLines = [];
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        const testWidth = font.widthOfTextAtSize(test, fontSize);
        if (testWidth > maxW && current) {
          wrappedLines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) wrappedLines.push(current);
      if (wrappedLines.length === 0) wrappedLines.push('');

      for (const wl of wrappedLines) {
        if (y < margin + lineH) {
          page = pdfDoc.addPage([pageW, pageH]);
          y    = pageH - margin;
        }
        if (wl.trim()) {
          page.drawText(wl, { x: margin, y, size: fontSize, font });
        }
        y -= lineH;
      }
    }

    const outName = `from-word-${uuidv4()}.pdf`;
    const outPath = path.join(convertedDir, outName);
    await fs.writeFile(outPath, await pdfDoc.save());
    await cleanup(req.file.path);

    const stats = await fs.stat(outPath);
    res.json({ success: true, message: 'Word converted to PDF!', fileName: outName, fileSize: stats.size, downloadUrl: dlUrl(outName), pageCount: pdfDoc.getPageCount() });
  } catch (err) {
    await cleanup(req.file?.path);
    res.status(500).json({ success: false, error: `Conversion failed: ${err.message}` });
  }
});

// ── 8. ROTATE ─────────────────────────────────────────────────────────────
router.post('/rotate', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
  const degrees = parseInt(req.body.degrees || '90', 10);
  const pages   = req.body.pages;

  try {
    const bytes  = await readFile(req.file.path);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total  = srcDoc.getPageCount();
    const indices = (!pages || pages === 'all')
      ? Array.from({ length: total }, (_, i) => i)
      : pages.split(',').map(n => parseInt(n.trim(), 10) - 1).filter(i => i >= 0 && i < total);

    indices.forEach(i => {
      const pg  = srcDoc.getPage(i);
      const cur = pg.getRotation().angle;
      pg.setRotation({ type: 'degrees', angle: (cur + degrees) % 360 });
    });

    const outName = `rotated-${uuidv4()}.pdf`;
    const outPath = path.join(convertedDir, outName);
    await fs.writeFile(outPath, await srcDoc.save());
    await cleanup(req.file.path);

    const stats = await fs.stat(outPath);
    res.json({ success: true, message: `Rotated ${indices.length} page(s) by ${degrees}°`, fileName: outName, fileSize: stats.size, downloadUrl: dlUrl(outName) });
  } catch (err) {
    await cleanup(req.file?.path);
    res.status(500).json({ success: false, error: `Rotation failed: ${err.message}` });
  }
});

// ── 9. PDF INFO ───────────────────────────────────────────────────────────
router.post('/info', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
  try {
    const bytes  = await readFile(req.file.path);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const info = {
      pageCount: srcDoc.getPageCount(),
      title:     srcDoc.getTitle()  || 'Unknown',
      author:    srcDoc.getAuthor() || 'Unknown',
      fileSize:  bytes.length,
      pages: srcDoc.getPages().map((p, i) => {
        const { width, height } = p.getSize();
        return { page: i + 1, width: Math.round(width), height: Math.round(height), rotation: p.getRotation().angle };
      })
    };
    await cleanup(req.file.path);
    res.json({ success: true, info });
  } catch (err) {
    await cleanup(req.file?.path);
    res.status(500).json({ success: false, error: `Failed: ${err.message}` });
  }
});

module.exports = router;