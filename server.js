/**
 * PDF Converter Pro - Main Server
 * Express.js backend for PDF conversion operations
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs-extra');

// Import routes
const pdfRoutes = require('./routes/pdf');
const uploadRoutes = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdnjs.cloudflare.com"
        ],

        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com"
        ],

        scriptSrc: [
          "'self'",
          "'unsafe-inline'"
        ],

        // Fix inline onclick/onchange errors
        scriptSrcAttr: [
          "'unsafe-inline'"
        ],

        imgSrc: [
          "'self'",
          "data:",
          "blob:"
        ],
      },
    },
  })
);

app.use(cors());

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', limiter);

// Body Parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Ensure Required Directories Exist
fs.ensureDirSync(path.join(__dirname, 'uploads'));
fs.ensureDirSync(path.join(__dirname, 'converted'));

// Routes
app.use('/api/pdf', pdfRoutes);
app.use('/api/upload', uploadRoutes);

// Serve Converted Files
app.use('/converted', express.static(path.join(__dirname, 'converted')));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'PDF Converter Pro is running!' });
});

// SPA Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    success: false
  });
});

// Auto-cleanup: Delete files older than 1 hour
const cleanupOldFiles = async () => {
  const dirs = ['uploads', 'converted'];
  const oneHour = 60 * 60 * 1000;
  for (const dir of dirs) {
    const dirPath = path.join(__dirname, dir);
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        if (Date.now() - stats.mtimeMs > oneHour) {
          await fs.remove(filePath);
        }
      }
    } catch (err) {}
  }
};

setInterval(cleanupOldFiles, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log('PDF Converter Pro running at http://localhost:' + PORT);
});

module.exports = app;
