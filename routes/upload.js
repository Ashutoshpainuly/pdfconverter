/**
 * Upload Routes
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.ensureDirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${ext} not supported`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// POST /api/upload/single
router.post('/single', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  res.json({
    success: true,
    file: {
      id: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      path: req.file.path,
      mimetype: req.file.mimetype
    }
  });
});

// POST /api/upload/multiple
router.post('/multiple', upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ success: false, error: 'No files uploaded' });
  res.json({
    success: true,
    files: req.files.map(f => ({
      id: f.filename,
      originalName: f.originalname,
      size: f.size,
      path: f.path,
      mimetype: f.mimetype
    }))
  });
});

// Error handler for multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

module.exports = router;
