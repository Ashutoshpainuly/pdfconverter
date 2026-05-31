const multer = require('multer');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');
const fs     = require('fs-extra');

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.ensureDirSync(uploadDir);

/* ── Storage: save with unique name ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase()),
});

/* ── File type whitelist ── */
const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf','.doc','.docx','.jpg','.jpeg','.png','.webp','.tiff'];
  const ext = path.extname(file.originalname).toLowerCase();
  allowed.includes(ext) ? cb(null, true) : cb(new Error('File type not supported'));
};

/* ── Multer instances ── */
const single   = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024, files: 1  } });
const multiple = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024, files: 10 } });

/* ── Wrap to return JSON errors ── */
const wrap = mw => (req, res, next) => mw(req, res, err => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_FILE_SIZE'  ? 'File exceeds 50MB limit'
            : err.code === 'LIMIT_FILE_COUNT' ? 'Max 10 files allowed'
            : err.message;
  res.status(400).json({ error: msg, success: false });
});

module.exports = {
  uploadSingle:   wrap(single.single('file')),
  uploadMultiple: wrap(multiple.array('files', 10)),
  uploadDir,
};
