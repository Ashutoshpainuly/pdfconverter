/* ── Tool Definitions ── */
const TOOLS = {
  'pdf-to-word': { label: 'PDF to Word',  badge: 'PDF → DOCX', accept: '.pdf',                  multi: false, icon: '📄', endpoint: '/api/pdf/to-word'      },
  'word-to-pdf': { label: 'Word to PDF',  badge: 'DOCX → PDF', accept: '.doc,.docx',             multi: false, icon: '📝', endpoint: '/api/pdf/word-to-pdf'  },
  'pdf-to-jpg':  { label: 'PDF to JPG',   badge: 'PDF → JPG',  accept: '.pdf',                  multi: false, icon: '🖼️', endpoint: '/api/pdf/to-images'    },
  'jpg-to-pdf':  { label: 'JPG to PDF',   badge: 'JPG → PDF',  accept: '.jpg,.jpeg,.png,.webp',  multi: true,  icon: '🖼️', endpoint: '/api/pdf/images-to-pdf'},
  'merge':       { label: 'Merge PDFs',   badge: 'PDF + PDF',  accept: '.pdf',                  multi: true,  icon: '📚', endpoint: '/api/pdf/merge'        },
  'split':       { label: 'Split PDF',    badge: 'PDF → Pages',accept: '.pdf',                  multi: false, icon: '📄', endpoint: '/api/pdf/split'        },
  'compress':    { label: 'Compress PDF', badge: 'PDF → Small',accept: '.pdf',                  multi: false, icon: '💾', endpoint: '/api/pdf/compress'     },
};

let currentTool  = 'pdf-to-word';
let selectedFiles = [];

/* ── Apply file input config for current tool ── */
function applyInputConfig() {
  const cfg = TOOLS[currentTool];
  const inp = document.getElementById('fileInput');
  inp.accept = cfg.accept;
  // IMPORTANT: must set/remove the attribute, not just the property, for some browsers
  if (cfg.multi) {
    inp.setAttribute('multiple', 'multiple');
  } else {
    inp.removeAttribute('multiple');
  }
}

/* ── Select Tool ── */
function selectTool(el) {
  document.querySelectorAll('.tool-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  currentTool = el.dataset.tool;
  const cfg = TOOLS[currentTool];
  document.getElementById('converterTitle').textContent = cfg.label;
  document.getElementById('converterBadge').textContent = cfg.badge;
  document.getElementById('dropSub').textContent =
    cfg.multi
      ? `Accepts ${cfg.accept.replace(/\./g,'').toUpperCase().replace(/,/g,', ')} · Max 50MB · Select multiple files`
      : `Accepts ${cfg.accept.replace(/\./g,'').toUpperCase().replace(/,/g,', ')} · Max 50MB`;
  applyInputConfig();
  clearFile();
  document.getElementById('converter').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── Drag & Drop ── */
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', e => handleFiles(e.target.files));

/* ── Handle Files ── */
function handleFiles(files) {
  if (!files || !files.length) return;
  const cfg = TOOLS[currentTool];
  let arr   = Array.from(files);

  // If single-file tool, only take the first file
  if (!cfg.multi) arr = [arr[0]];

  // Validate size
  const oversized = arr.filter(f => f.size > 50 * 1024 * 1024);
  if (oversized.length) { toast('One or more files exceed the 50MB limit', 'error'); return; }

  // Validate types
  const allowed = cfg.accept.split(',').map(a => a.trim().toLowerCase());
  const wrong   = arr.filter(f => {
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    return !allowed.includes(ext);
  });
  if (wrong.length) {
    toast(`Wrong file type. Expected: ${cfg.accept}`, 'error');
    return;
  }

  // Merge requires at least 2
  if (currentTool === 'merge' && arr.length < 2) {
    toast('Please select at least 2 PDF files to merge', 'error');
    // Still allow them to add the first file and show it
  }

  selectedFiles = arr;

  const preview = document.getElementById('filePreview');
  preview.classList.add('show');
  document.getElementById('previewIcon').textContent = cfg.icon;
  document.getElementById('fileName').textContent =
    arr.length === 1 ? arr[0].name : `${arr.length} files selected`;
  document.getElementById('fileSize').textContent =
    arr.length === 1
      ? formatSize(arr[0].size)
      : formatSize(arr.reduce((a, f) => a + f.size, 0)) + ' total';

  const canConvert = currentTool === 'merge' ? arr.length >= 2 : arr.length >= 1;
  document.getElementById('convertBtn').disabled = !canConvert;
  document.getElementById('convertBtnText').textContent =
    canConvert
      ? `Convert ${arr.length > 1 ? arr.length + ' files' : 'file'} →`
      : 'Select at least 2 files to merge';

  toast(`${arr.length} file${arr.length > 1 ? 's' : ''} ready`, 'info');
}

/* ── Clear File ── */
function clearFile() {
  selectedFiles = [];
  document.getElementById('filePreview').classList.remove('show');
  document.getElementById('progressWrap').classList.remove('show');
  document.getElementById('convertBtn').disabled = true;
  document.getElementById('convertBtnText').textContent = 'Select a file first';
  document.getElementById('spinner').classList.remove('show');
  document.getElementById('fileInput').value = '';
  setProgress(0, '');
}

/* ── Set Progress ── */
function setProgress(pct, label) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent  = pct + '%';
  if (label) document.getElementById('progressLabel').textContent = label;
}

/* ── Convert ── */
function doConvert() {
  if (!selectedFiles.length) return;
  const cfg = TOOLS[currentTool];

  // Extra guard for merge
  if (currentTool === 'merge' && selectedFiles.length < 2) {
    toast('Please select at least 2 PDF files to merge', 'error');
    return;
  }

  const btn          = document.getElementById('convertBtn');
  const spinner      = document.getElementById('spinner');
  const btnText      = document.getElementById('convertBtnText');
  const progressWrap = document.getElementById('progressWrap');

  btn.disabled = true;
  spinner.classList.add('show');
  btnText.textContent = 'Converting…';
  progressWrap.classList.add('show');
  setProgress(10, 'Uploading file…');

  const fd = new FormData();
  if (cfg.multi) {
    selectedFiles.forEach(f => fd.append('files', f));
  } else {
    fd.append('file', selectedFiles[0]);
  }

  const xhr = new XMLHttpRequest();
  xhr.open('POST', cfg.endpoint, true);
  xhr.responseType = 'json';

  xhr.upload.onprogress = e => {
    if (e.lengthComputable)
      setProgress(Math.round((e.loaded / e.total) * 60) + 10, 'Uploading…');
  };

  xhr.onload = () => {
    const data = xhr.response;
    spinner.classList.remove('show');
    btn.disabled   = false;
    btnText.textContent = 'Convert Again';

    if (xhr.status === 200 && data && data.success) {
      setProgress(90, 'Almost done…');
      fetch(data.downloadUrl)
        .then(r => { if (!r.ok) throw new Error('Download failed'); return r.blob(); })
        .then(blob => {
          setProgress(100, 'Done!');
          const url = URL.createObjectURL(blob);
          const a   = document.createElement('a');
          a.href     = url;
          a.download = data.fileName || 'converted-file';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          toast('✓ ' + (data.message || 'Conversion complete!'), 'success');
          if (data.note) setTimeout(() => toast('ℹ ' + data.note, 'info'), 1000);
          setTimeout(clearFile, 3000);
        })
        .catch(err => {
          toast('Download failed: ' + err.message, 'error');
          setProgress(0, '');
        });
    } else {
      const msg = (data && data.error) ? data.error : 'Conversion failed. Please try again.';
      toast(msg, 'error');
      setProgress(0, '');
    }
  };

  xhr.onerror = () => {
    toast('Network error. Is the server running on port 3000?', 'error');
    spinner.classList.remove('show');
    btn.disabled = false;
    btnText.textContent = 'Try Again';
    setProgress(0, '');
  };

  xhr.send(fd);
}

/* ── FAQ Toggle ── */
function toggleFaq(item) { item.classList.toggle('open'); }

/* ── Toast ── */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideIn .3s ease reverse';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

/* ── Format File Size ── */
function formatSize(bytes) {
  if (bytes < 1024)         return bytes + ' B';
  if (bytes < 1024 * 1024)  return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── Init on page load ── */
applyInputConfig();