/* =========================================================
   EasyResume - script.js
   Handles: form input, dynamic sections, live preview,
   and a placeholder AI chat panel.
   ========================================================= */

/* =========================================================
   TEMPLATE SYSTEM
   =========================================================

   HOW TO ADD A NEW TEMPLATE:
   1. Call registerTemplate({ ...config }) with your new template.
   2. Add its CSS to style.css scoped under .resume-paper.your-css-class
   3. Add its thumbnail HTML in the thumbnailHTML property.
   4. Add its template ID to the correct section in renderTemplatesPage().
   That's it — no other changes needed anywhere.
   ========================================================= */

var TemplateRegistry = {};

function registerTemplate(config) {
  TemplateRegistry[config.id] = config;
}

/* Formats a month+year range for templates. Preserves user's casing. */
function formatPeriod(sm, sy, em, ey, ongoing) {
  var M = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var s = (sm && sy) ? M[+sm] + ' ' + sy : (sy ? '' + sy : '');
  var e = ongoing ? 'Present' : ((em && ey) ? M[+em] + ' ' + ey : (ey ? '' + ey : ''));
  if (s && e) return s + ' \u2013 ' + e;
  return s || e || '';
}

/* =========================================================
   LINK HELPERS — URL sanitization, safe anchor generation
   ========================================================= */

function sanitizeUrl(url) {
  if (!url) return '';
  url = String(url).trim();
  if (!url) return '';
  // Add https:// if no protocol present
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    var p = new URL(url);
    return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : '';
  } catch (e) { return ''; }
}

function isValidUrl(url) {
  if (!url || !String(url).trim()) return true; // empty is fine (optional fields)
  return sanitizeUrl(url) !== '';
}

/* Returns a clickable <a> tag or plain escaped text if URL is invalid */
function safeLink(url, label) {
  var clean = sanitizeUrl(url);
  if (!clean) return escHtml(label || url || '');
  return '<a href="' + escHtml(clean) + '" target="_blank" rel="noopener noreferrer" title="' + escHtml(clean) + '">'
    + escHtml(label || clean) + '</a>';
}

/* mailto: link for emails */
function safeMailto(email) {
  if (!email || !email.trim()) return '';
  return '<a href="mailto:' + escHtml(email.trim()) + '">' + escHtml(email) + '</a>';
}

/* tel: link for phone numbers */
function safeTel(phone) {
  if (!phone || !phone.trim()) return '';
  var digits = phone.replace(/[^\d+\-\s()]/g, '');
  return '<a href="tel:' + escHtml(phone.replace(/\s/g, '')) + '">' + escHtml(phone) + '</a>';
}

/* =========================================================
   RICH TEXT FORMATTING MODEL
   Formatting is NEVER stored as HTML inside a resume's text
   fields. Every field in currentResume.data (summary.text, a
   bullet's .text, etc) always holds plain text only -- exactly
   what the person typed -- because that is also exactly what
   the Resume Form's textareas read from. The Resume Form must
   never show HTML tags, so the data it's bound to must never
   contain any.

   Inline formatting (bold/italic/underline/strike/color/
   highlight/font-size/letter-spacing) lives separately, in
   currentResume.formatting, keyed by the same "field path" used
   by data-br-field (e.g. "summary.text" or
   "projects[ID].bullets[ID].text"). Each entry is an array of
   non-overlapping character-offset segments:
     [{ start, end, bold, italic, underline, strike,
        color, background, fontSize, letterSpacing }, ...]
   Gaps between segments are implicitly unformatted -- only
   styled ranges are stored. rf() re-applies these segments over
   the plain text on every render (load, template switch, section
   reorder, undo/redo, PDF export), so formatting always comes
   from data + metadata, never from whatever happens to be
   sitting in the live DOM.
   ========================================================= */

var RICH_STYLE_KEYS = ['bold', 'italic', 'underline', 'strike', 'color', 'background', 'fontSize', 'letterSpacing'];

function hasAnyStyle(style) {
  return !!style && RICH_STYLE_KEYS.some(function (k) { return !!style[k]; });
}

function stylesEqual(a, b) {
  return RICH_STYLE_KEYS.every(function (k) { return (a[k] || null) === (b[k] || null); });
}

/* Merge adjacent segments that carry identical styles, drop empty/
   zero-length/unstyled ones. This is what keeps the underlying model
   (and therefore the rendered preview DOM) clean -- no duplicate or
   fragmented styling ever accumulates from repeated edits. */
function normalizeSegments(segments) {
  var clean = segments
    .filter(function (s) { return s && s.end > s.start && hasAnyStyle(s); })
    .sort(function (a, b) { return a.start - b.start; });
  var out = [];
  clean.forEach(function (s) {
    var last = out[out.length - 1];
    if (last && last.end === s.start && stylesEqual(last, s)) {
      last.end = s.end;
    } else {
      out.push({
        start: s.start, end: s.end, bold: s.bold || false, italic: s.italic || false,
        underline: s.underline || false, strike: s.strike || false,
        color: s.color || null, background: s.background || null,
        fontSize: s.fontSize || null, letterSpacing: s.letterSpacing || null
      });
    }
  });
  return out;
}

function getFieldSegments(path) {
  if (!currentResume || !currentResume.formatting) return [];
  return currentResume.formatting[path] || [];
}

function setFieldSegments(path, segments) {
  if (!currentResume) return;
  if (!currentResume.formatting) currentResume.formatting = {};
  var normalized = normalizeSegments(segments);
  if (normalized.length) currentResume.formatting[path] = normalized;
  else delete currentResume.formatting[path];
}

function styleAt(segments, pos) {
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].start <= pos && pos < segments[i].end) return segments[i];
  }
  return {};
}

/* Split existing segments at the [start,end) boundary and run `patchFn`
   over the style covering each sub-range that falls inside [start,end).
   Anything outside [start,end) is left completely untouched -- this is
   what lets bold+color, underline+color, highlight+bold etc. stack
   correctly instead of one style silently replacing another. */
function editSegments(path, start, end, patchFn) {
  if (start >= end) return;
  var segments = getFieldSegments(path);

  var pointSet = {};
  pointSet[start] = true; pointSet[end] = true;
  segments.forEach(function (s) { pointSet[s.start] = true; pointSet[s.end] = true; });
  var sorted = Object.keys(pointSet).map(Number).sort(function (a, b) { return a - b; });

  var result = [];
  segments.forEach(function (s) {
    if (s.end <= start || s.start >= end) result.push(s); /* untouched */
  });

  for (var i = 0; i < sorted.length - 1; i++) {
    var segStart = sorted[i], segEnd = sorted[i + 1];
    if (segEnd <= segStart || segStart < start || segEnd > end) continue;
    var existing = styleAt(segments, (segStart + segEnd) / 2);
    var patched = patchFn({
      bold: existing.bold, italic: existing.italic, underline: existing.underline,
      strike: existing.strike, color: existing.color, background: existing.background,
      fontSize: existing.fontSize, letterSpacing: existing.letterSpacing
    });
    if (hasAnyStyle(patched)) {
      result.push({
        start: segStart, end: segEnd,
        bold: patched.bold, italic: patched.italic, underline: patched.underline,
        strike: patched.strike, color: patched.color, background: patched.background,
        fontSize: patched.fontSize, letterSpacing: patched.letterSpacing
      });
    }
  }

  setFieldSegments(path, result);
}

/* True only if `prop` is on for every point across [start,end) -- used
   to decide whether Bold/Italic/Underline/Strike should toggle ON or
   OFF for the current selection. */
function isStyleUniform(segments, start, end, prop) {
  if (end <= start) return false;
  var points = [start];
  segments.forEach(function (s) { if (s.start > start && s.start < end) points.push(s.start); });
  var val = null;
  for (var i = 0; i < points.length; i++) {
    var v = !!styleAt(segments, points[i])[prop];
    if (val === null) val = v; else if (v !== val) return false;
  }
  return !!val;
}

/* ---- Render plain text + segments into safe, FLAT HTML. Every styled
   run gets exactly one <span> -- never nested inside each other -- so
   there is no "nested span explosion" by construction, and repeated
   formatting actions can never make the preview DOM messier over time. ---- */
function renderFormattedText(text, segments) {
  text = text || '';
  if (!segments || !segments.length) return escHtml(text);

  var sorted = segments.slice().sort(function (a, b) { return a.start - b.start; });
  var html = '';
  var pos = 0;
  sorted.forEach(function (s) {
    var start = Math.max(0, Math.min(s.start, text.length));
    var end   = Math.max(start, Math.min(s.end, text.length));
    if (start > pos) html += escHtml(text.slice(pos, start));
    if (end > start) {
      var css = [];
      if (s.bold)   css.push('font-weight:bold');
      if (s.italic) css.push('font-style:italic');
      var decos = [];
      if (s.underline) decos.push('underline');
      if (s.strike)    decos.push('line-through');
      if (decos.length) css.push('text-decoration:' + decos.join(' '));
      if (s.color)          css.push('color:' + s.color);
      if (s.background)     css.push('background-color:' + s.background);
      if (s.fontSize)       css.push('font-size:' + s.fontSize);
      if (s.letterSpacing)  css.push('letter-spacing:' + s.letterSpacing);
      html += '<span style="' + css.join(';') + '">' + escHtml(text.slice(start, end)) + '</span>';
    }
    pos = end;
  });
  if (pos < text.length) html += escHtml(text.slice(pos));
  return html;
}

/* Build the `data-br-field` attribute + rendered content for a
   rich-text-eligible element in one go, so template code stays terse:
     '<div class="x"' + rf('projects[' + p.id + '].description', p.description) + '</div>'
   `path` supports plain dotted paths ("summary.text") AND array-item
   paths ("projects[ID].bullets[ID].text") addressed by each item's id.
   `rawValue` is always plain text -- formatting comes entirely from
   currentResume.formatting[path], never from the text itself. */
function rf(path, rawValue) {
  var text = stripHtmlToPlainText(rawValue || '');
  var html = renderFormattedText(text, getFieldSegments(path));
  return ' data-br-field="' + path + '" data-br-rich="1">' + html;
}

/* Resolve a (possibly array-indexed-by-id) path against an object,
   returning {get,set} accessors, or null if any segment can't be found. */
function resolveRichPath(root, path) {
  var segs = path.split('.');
  var cur = root;
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i];
    var m = seg.match(/^([a-zA-Z0-9_]+)\[([^\]]+)\]$/);
    if (m) {
      var arrKey = m[1], id = m[2];
      var arr = cur ? cur[arrKey] : null;
      if (!Array.isArray(arr)) return null;
      var idx = arr.findIndex(function (it) { return it && String(it.id) === id; });
      if (idx === -1) return null;
      if (i === segs.length - 1) {
        return { get: function () { return arr[idx]; }, set: function (v) { arr[idx] = v; } };
      }
      cur = arr[idx];
    } else {
      if (i === segs.length - 1) {
        if (!cur) return null;
        return { get: function () { return cur[seg]; }, set: function (v) { cur[seg] = v; } };
      }
      if (!cur || cur[seg] == null) return null;
      cur = cur[seg];
    }
  }
  return null;
}

function setRichFieldValue(path, value) {
  if (!currentResume) return;
  var resolved = resolveRichPath(currentResume.data, path);
  if (resolved) resolved.set(value);
}

function getRichFieldValue(path) {
  if (!currentResume) return '';
  var resolved = resolveRichPath(currentResume.data, path);
  var v = resolved ? resolved.get() : '';
  return v || '';
}

/* =========================================================
   SELECTION TRACKING (offset-based, survives focus loss)
   Instead of keeping a live DOM Range -- which becomes invalid
   the instant the preview re-renders, and is thrown away by the
   browser the instant focus moves to the formatting sidebar --
   the current selection is tracked as plain-text character
   offsets within a field: { path, start, end }. Offsets stay
   meaningful across re-renders, so "select text in the preview,
   move the mouse to the sidebar, click a color swatch" works
   every time, instead of only when the click happens to land
   before the browser clears the selection.
   ========================================================= */

var lastFieldSelection = null; /* { path, start, end } | null */

/* Plain-text character offset of (node, offset) relative to
   `container`, found by walking every text node under container in
   document order via TreeWalker. */
function textOffsetWithin(container, node, offset) {
  if (node.nodeType === 1) {
    var childBefore = node.childNodes[offset] || null;
    var total = 0;
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var tnode;
    while ((tnode = walker.nextNode())) {
      if (childBefore && (tnode === childBefore || childBefore.contains(tnode))) return total;
      total += tnode.nodeValue.length;
    }
    return total;
  }
  var total2 = 0;
  var walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  var tnode2;
  while ((tnode2 = walker2.nextNode())) {
    if (tnode2 === node) return total2 + offset;
    total2 += tnode2.nodeValue.length;
  }
  return total2;
}

/* Inverse of textOffsetWithin: find the (node, offset) that sits at a
   given plain-text character position within `container`. Used to
   restore a visible selection after re-rendering a field. */
function findTextPosition(container, targetOffset) {
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  var total = 0, node, last = null;
  while ((node = walker.nextNode())) {
    var len = node.nodeValue.length;
    if (total + len >= targetOffset) return { node: node, offset: targetOffset - total };
    total += len;
    last = node;
  }
  if (last) return { node: last, offset: last.nodeValue.length };
  return null;
}

/* Find the nearest data-br-field ancestor of a Range and convert the
   Range into { path, start, end } plain-text offsets within it. */
function getFieldSelectionFromRange(range) {
  var node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  var fieldEl = node;
  while (fieldEl && !(fieldEl.nodeType === 1 && fieldEl.hasAttribute && fieldEl.hasAttribute('data-br-field'))) {
    fieldEl = fieldEl.parentNode;
  }
  if (!fieldEl) return null;
  var path  = fieldEl.getAttribute('data-br-field');
  var start = textOffsetWithin(fieldEl, range.startContainer, range.startOffset);
  var end   = textOffsetWithin(fieldEl, range.endContainer, range.endOffset);
  if (end < start) { var t = start; start = end; end = t; }
  return { path: path, start: start, end: end };
}

/* Keep lastFieldSelection up to date any time there's a real,
   non-collapsed selection inside the preview. Deliberately does NOT
   clear on blur/collapse (e.g. clicking into the sidebar) -- that is
   exactly what makes "select in preview, then click a sidebar swatch"
   work reliably. */
document.addEventListener('selectionchange', function () {
  var preview = document.getElementById('resumePreview');
  var sel = window.getSelection();
  if (!preview || !sel || !sel.rangeCount || sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  if (!preview.contains(range.commonAncestorContainer)) return;
  var info = getFieldSelectionFromRange(range);
  if (info && info.end > info.start) lastFieldSelection = info;
});

/* Re-render the preview from data + formatting, then restore a visible
   selection over [start,end) in the freshly rendered field so the
   floating toolbar / inspector stay in sync with what was just done. */
function refreshFieldAndReselect(path, start, end) {
  renderPreview();
  var safePath = path.replace(/"/g, '\\"');
  var el = document.querySelector('[data-br-field="' + safePath + '"]');
  if (!el) return;
  try {
    var startPos = findTextPosition(el, start);
    var endPos   = findTextPosition(el, end);
    if (startPos && endPos) {
      var range = document.createRange();
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, endPos.offset);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (e) { /* formatting is already applied & saved either way */ }
}

/* =========================================================
   SELECTION-BASED FORMATTING ENGINE
   Every action below reads/writes currentResume.formatting
   (never the DOM, never document.execCommand) using the
   offset-based selection tracked above, so formatting survives
   save/reload/undo-redo/template switch/section reorder/PDF
   export exactly like any other field in the data model.
   ========================================================= */

/* Make the preview editable so the browser tracks cursor/selection */
function makePreviewEditable() {
  var p = document.getElementById('resumePreview');
  if (p) {
    p.contentEditable = 'true';
    p.spellcheck      = false;
  }
}

function requireSelection() {
  if (!lastFieldSelection || lastFieldSelection.end <= lastFieldSelection.start) {
    showToast('Select text in the Resume Preview first.', 'error');
    return null;
  }
  return lastFieldSelection;
}

function applyStylePatchToSelection(patch) {
  var sel = requireSelection();
  if (!sel) return;
  editSegments(sel.path, sel.start, sel.end, function (style) {
    return Object.assign({}, style, patch);
  });
  refreshFieldAndReselect(sel.path, sel.start, sel.end);
  updateFloatingToolbarState();
  debouncePushHistory();
  scheduleAutoSave();
}

var INLINE_STYLE_PROP_MAP = { bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strike' };

/* ---- Toggle bold/italic/underline/strike over the current selection ---- */
function fmtCmd(command) {
  var prop = INLINE_STYLE_PROP_MAP[command];
  if (!prop) return;
  var sel = requireSelection();
  if (!sel) return;
  var segments = getFieldSegments(sel.path);
  var turnOn = !isStyleUniform(segments, sel.start, sel.end, prop);
  var patch = {};
  patch[prop] = turnOn;
  applyStylePatchToSelection(patch);
}

/* ---- Font size via stored style metadata (font-size) ---- */
function fmtFontSize(sizePx) {
  if (!sizePx) return;
  applyStylePatchToSelection({ fontSize: sizePx + 'px' });
}

/* ---- Text / highlight color ---- */
function fmtColor(command, colorHex) {
  if (command === 'foreColor') {
    applyStylePatchToSelection({ color: colorHex });
    var dot = document.getElementById('ftColorDot');
    if (dot) dot.style.background = colorHex;
    var inp = document.getElementById('ftColorInput');
    if (inp) inp.value = colorHex;
  } else {
    applyStylePatchToSelection({ background: colorHex });
    var hdot = document.getElementById('ftHiDot');
    if (hdot) hdot.style.background = colorHex;
    var hinp = document.getElementById('ftHiInput');
    if (hinp) hinp.value = colorHex;
  }
}

/* ---- Line height on the selected paragraph block ----
   Kept as a live per-block DOM style rather than part of the
   run-level rich-text model above, since it targets a whole
   paragraph rather than a run of text. */
function fmtLineHeight(value) {
  if (!value) return;
  var preview = document.getElementById('resumePreview');
  if (!preview) return;
  preview.focus();

  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  var node = sel.anchorNode;
  while (node && node !== preview) {
    var tag = node.nodeName ? node.nodeName.toLowerCase() : '';
    var blockTags = ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'span'];
    if (node.nodeType === 1 && blockTags.indexOf(tag) !== -1) {
      node.style.lineHeight = value;
      break;
    }
    node = node.parentNode;
  }
  updateFloatingToolbarState();
  debouncePushHistory();
}

/* ---- Letter spacing via stored style metadata (letter-spacing) ---- */
function fmtLetterSpacing(value) {
  if (!value) return;
  applyStylePatchToSelection({ letterSpacing: value });
}

/* ---- Clear ALL inline formatting from the selected range ----
   Resets every style property across [start,end) to nothing, so the
   underlying plain text is completely untouched but comes out
   unstyled on the next render -- no leftover span, no leftover
   metadata, nothing left to "not fully remove". */
function fmtClear() {
  var sel = requireSelection();
  if (!sel) return;
  editSegments(sel.path, sel.start, sel.end, function () { return {}; });
  refreshFieldAndReselect(sel.path, sel.start, sel.end);
  updateFloatingToolbarState();
  debouncePushHistory();
  scheduleAutoSave();
}

/* =========================================================
   FORMATTING INSPECTOR
   Shows the currently selected text's active styles (bold?
   italic? color? font-size? etc) computed straight from the
   formatting metadata for the current selection range -- not
   from walking the DOM -- so it stays correct even though the
   preview HTML is just flat, non-nested spans now.
   ========================================================= */
function getSelectionFormatState() {
  var state = { bold: false, italic: false, underline: false, strike: false,
                color: null, background: null, fontSize: null, letterSpacing: null };
  if (!lastFieldSelection || lastFieldSelection.end <= lastFieldSelection.start) return state;
  var sel = lastFieldSelection;
  var segments = getFieldSegments(sel.path);

  ['bold', 'italic', 'underline', 'strike'].forEach(function (p) {
    state[p] = isStyleUniform(segments, sel.start, sel.end, p);
  });

  ['color', 'background', 'fontSize', 'letterSpacing'].forEach(function (p) {
    var points = [sel.start];
    segments.forEach(function (s) { if (s.start > sel.start && s.start < sel.end) points.push(s.start); });
    var first = styleAt(segments, sel.start)[p] || null;
    var uniform = points.every(function (pos) { return (styleAt(segments, pos)[p] || null) === first; });
    state[p] = uniform ? first : null;
  });

  return state;
}

function rgbToHex(rgb) {
  if (!rgb) return null;
  if (/^#/.test(rgb)) return rgb;
  var m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return '#' + m.slice(0, 3).map(function (n) {
    return ('0' + parseInt(n, 10).toString(16)).slice(-2);
  }).join('');
}

/* Best-effort human-readable names for the fixed swatch palettes so
   the inspector can say "Red Color" / "Highlight Yellow" instead of
   just a hex code -- falls back to the hex code for custom colors. */
var HIGHLIGHT_COLOR_NAMES = {
  '#ffff00': 'Yellow', '#90ee90': 'Green', '#add8e6': 'Blue',
  '#ffb6c1': 'Pink', '#ffa500': 'Orange', '#e6e6fa': 'Lavender', '#ffffff': 'None'
};
var TEXT_COLOR_NAMES = {
  '#ff0000': 'Red', '#008000': 'Green', '#0000ff': 'Blue', '#000000': 'Black',
  '#ffffff': 'White', '#ffa500': 'Orange', '#800080': 'Purple', '#ffc0cb': 'Pink',
  '#a52a2a': 'Brown', '#808080': 'Gray', '#ffff00': 'Yellow'
};

function colorLabel(hex, names) {
  var norm = rgbToHex(hex);
  if (!norm) return hex;
  var name = names[norm.toLowerCase()];
  return name || norm.toUpperCase();
}

function renderSelectionInspector() {
  var box = document.getElementById('fmtInspector');
  if (!box) return;
  var s = getSelectionFormatState();
  var active = s.bold || s.italic || s.underline || s.strike || s.color || s.background || s.fontSize || s.letterSpacing;

  if (!active) {
    box.innerHTML = '<span class="fmt-inspector-empty">No formatting on current selection</span>';
    return;
  }

  var chips = [];
  if (s.bold)      chips.push('<span class="fmt-chip">\u2713 Bold</span>');
  if (s.italic)    chips.push('<span class="fmt-chip">\u2713 Italic</span>');
  if (s.underline) chips.push('<span class="fmt-chip">\u2713 Underline</span>');
  if (s.strike)    chips.push('<span class="fmt-chip">\u2713 Strikethrough</span>');
  if (s.color) {
    chips.push('<span class="fmt-chip"><span class="fmt-chip-swatch" style="background:' + escHtml(s.color) + ';"></span>\u2713 ' + escHtml(colorLabel(s.color, TEXT_COLOR_NAMES)) + ' Color</span>');
  }
  if (s.background) {
    chips.push('<span class="fmt-chip"><span class="fmt-chip-swatch" style="background:' + escHtml(s.background) + ';"></span>\u2713 Highlight ' + escHtml(colorLabel(s.background, HIGHLIGHT_COLOR_NAMES)) + '</span>');
  }
  if (s.fontSize)      chips.push('<span class="fmt-chip">\u2713 ' + escHtml(s.fontSize) + '</span>');
  if (s.letterSpacing) chips.push('<span class="fmt-chip">\u2713 Spacing ' + escHtml(s.letterSpacing) + '</span>');

  box.innerHTML = chips.join('');
}


/* =========================================================
   FLOATING TOOLBAR — SHOW / HIDE / POSITION
   ========================================================= */

var _ftHideTimer = null;

function showFloatingToolbar() {
  clearTimeout(_ftHideTimer);

  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    scheduleHideToolbar();
    return;
  }

  var preview = document.getElementById('resumePreview');
  if (!preview) return;

  var range = sel.getRangeAt(0);
  /* Only show if selection is actually inside the preview */
  if (!preview.contains(range.commonAncestorContainer)) {
    scheduleHideToolbar();
    return;
  }

  var rect    = range.getBoundingClientRect();
  var toolbar = document.getElementById('selectionToolbar');
  if (!toolbar) return;

  toolbar.classList.add('ft-visible');

  /* Position above selection, centered horizontally, clamped to viewport */
  var tbW = toolbar.offsetWidth  || 520;
  var tbH = toolbar.offsetHeight || 42;

  var left = rect.left + rect.width / 2 - tbW / 2;
  var top  = rect.top  - tbH - 10;

  /* Clamp: don't go off left/right edges */
  left = Math.max(8, Math.min(left, window.innerWidth - tbW - 8));
  /* If no room above, show below selection instead */
  if (top < 58) {
    top = rect.bottom + 10;
    toolbar.style.setProperty('--arrow-size', '0px'); /* hide arrow when flipped */
  } else {
    toolbar.style.setProperty('--arrow-size', '6px');
  }

  toolbar.style.left = left + 'px';
  toolbar.style.top  = top  + 'px';

  updateFloatingToolbarState();
}

function scheduleHideToolbar() {
  _ftHideTimer = setTimeout(function() {
    var toolbar = document.getElementById('selectionToolbar');
    if (toolbar) toolbar.classList.remove('ft-visible');
  }, 180);
}

function hideFloatingToolbar() {
  clearTimeout(_ftHideTimer);
  var toolbar = document.getElementById('selectionToolbar');
  if (toolbar) toolbar.classList.remove('ft-visible');
}

/* Reflect current selection state (bold active? italic active?) in toolbar */
function updateFloatingToolbarState() {
  var s = getSelectionFormatState();

  /* Floating toolbar buttons */
  var ftMap = { ftBold: 'bold', ftItalic: 'italic', ftUnder: 'underline', ftStrike: 'strike' };
  Object.keys(ftMap).forEach(function(btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.classList.toggle('ft-active', !!s[ftMap[btnId]]);
  });

  /* Format drawer B/I/U buttons (if drawer is open) */
  var drawerMap = { fmtBoldBtn: 'bold', fmtItalBtn: 'italic', fmtUnderBtn: 'underline', fmtStrikeBtn: 'strike' };
  Object.keys(drawerMap).forEach(function(btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.classList.toggle('active', !!s[drawerMap[btnId]]);
  });

  renderSelectionInspector();
}

/* Wire up mouseup on the preview — deferred so selection is finalized */
var _selToolbarInited = false;

function initSelectionToolbar() {
  /* Guard: only wire document-level listeners once.
     The preview element itself is replaced on each render so
     we delegate to the stable .preview-panel .panel-body instead. */
  if (_selToolbarInited) return;
  _selToolbarInited = true;

  var previewPanel = document.querySelector('.preview-panel .panel-body');
  if (!previewPanel) return;

  /* Show toolbar on mouse release inside the preview panel */
  previewPanel.addEventListener('mouseup', function (e) {
    var toolbar = document.getElementById('selectionToolbar');
    if (toolbar && toolbar.contains(e.target)) return; /* ignore toolbar clicks */
    setTimeout(showFloatingToolbar, 40);
  });

  /* Show toolbar on keyboard selection (Shift+Arrow etc.) */
  previewPanel.addEventListener('keyup', function () {
    setTimeout(showFloatingToolbar, 40);
  });

  /* Hide when clicking outside preview panel and toolbar */
  document.addEventListener('mousedown', function (e) {
    var toolbar  = document.getElementById('selectionToolbar');
    var preview  = document.getElementById('resumePreview');
    var fmtPanel = document.getElementById('formatDrawer');
    if (!toolbar) return;
    var inToolbar  = toolbar.contains(e.target);
    var inPreview  = preview  && preview.contains(e.target);
    var inDrawer   = fmtPanel && fmtPanel.contains(e.target);
    if (!inToolbar && !inPreview && !inDrawer) {
      scheduleHideToolbar();
    }
  });

  /* Selection is tracked via lastFieldSelection (offset-based), so
     color pickers no longer need a DOM Range snapshot on mousedown. */

  /* Keyboard shortcuts: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z */
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.key === 'z' && !e.shiftKey) {
      /* Undo — but only when NOT inside the preview (let the browser
         handle its own undo for contenteditable text insertion) */
      var preview = document.getElementById('resumePreview');
      var active  = document.activeElement;
      var inPrev  = preview && (preview === active || preview.contains(active));

      if (!inPrev) {
        e.preventDefault();
        undoChange();
      }
    }

    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
      var preview2 = document.getElementById('resumePreview');
      var active2  = document.activeElement;
      var inPrev2  = preview2 && (preview2 === active2 || preview2.contains(active2));
      if (!inPrev2) {
        e.preventDefault();
        redoChange();
      }
    }
  });
}

/* Validate a URL input field visually on blur */
function validateUrlField(input) {
  var val = input.value.trim();
  var msgId = input.dataset.msgId;
  var existing = msgId ? document.getElementById(msgId) : null;

  if (val && !isValidUrl(val)) {
    input.classList.add('url-invalid');
    if (!existing) {
      var msg = document.createElement('span');
      var id  = 'urlmsg_' + generateId();
      msg.id  = id;
      msg.className = 'url-invalid-msg';
      msg.textContent = 'Enter a valid URL (https://...)';
      input.dataset.msgId = id;
      input.parentNode.appendChild(msg);
    }
  } else {
    input.classList.remove('url-invalid');
    if (existing) existing.remove();
  }
}

/* =========================================================
   HISTORY — UNDO / REDO
   Snapshots include all data + preview HTML so that inline
   edits survive undo just as well as form-driven changes.
   ========================================================= */

var HISTORY_MAX  = 60;
var _history     = [];
var _histIdx     = -1;
var _histPaused  = false;   /* prevents observer loops during restore */
var _histTimer   = null;

/* Call this after every user-driven change (debounced so fast typing
   doesn't flood the stack). Direct calls are for structural actions. */
function pushHistory() {
  if (_histPaused || !currentResume) return;

  var snap = {
    data:         JSON.parse(JSON.stringify(currentResume.data)),
    sections:     JSON.parse(JSON.stringify(currentResume.sections)),
    sectionOrder: JSON.parse(JSON.stringify(currentResume.sectionOrder || [])),
    format:       JSON.parse(JSON.stringify(currentResume.format || DEFAULT_FORMAT)),
    formatting:   JSON.parse(JSON.stringify(currentResume.formatting || {}))
  };

  /* Drop any redoable future */
  _history = _history.slice(0, _histIdx + 1);
  _history.push(snap);
  if (_history.length > HISTORY_MAX) _history.shift();
  _histIdx = _history.length - 1;

  updateUndoRedoBtns();
}

/* Debounced push — used by form field updates */
function debouncePushHistory() {
  clearTimeout(_histTimer);
  _histTimer = setTimeout(pushHistory, 900);
}

function undoChange() {
  if (_histIdx <= 0) { showToast('Nothing to undo.', 'error'); return; }
  _histIdx--;
  applyHistorySnap(_history[_histIdx]);
}

function redoChange() {
  if (_histIdx >= _history.length - 1) { showToast('Nothing to redo.', 'error'); return; }
  _histIdx++;
  applyHistorySnap(_history[_histIdx]);
}

function applyHistorySnap(snap) {
  if (!snap || !currentResume) return;
  _histPaused = true;
  _suspendMutObs = true;

  currentResume.data         = JSON.parse(JSON.stringify(snap.data));
  currentResume.sections     = JSON.parse(JSON.stringify(snap.sections));
  currentResume.sectionOrder = JSON.parse(JSON.stringify(snap.sectionOrder));
  currentResume.format       = JSON.parse(JSON.stringify(snap.format));
  currentResume.formatting   = JSON.parse(JSON.stringify(snap.formatting || {}));
  lastFieldSelection = null;

  /* Always reconstruct the preview from data + formatting metadata --
     never from a saved raw-HTML snapshot -- so undo/redo of a
     formatting action (apply color -> undo -> color removed -> redo
     -> color restored) is driven by the same source of truth as
     every other render. */
  renderPreview();

  renderBuilderForm();
  renderCompletenessBar();
  updatePageIndicator();
  updateUndoRedoBtns();
  scheduleAutoSave();

  setTimeout(function () {
    _histPaused    = false;
    _suspendMutObs = false;
  }, 120);
}

function updateUndoRedoBtns() {
  var u = document.getElementById('undoBtn');
  var r = document.getElementById('redoBtn');
  if (u) u.disabled = _histIdx <= 0;
  if (r) r.disabled = _histIdx >= _history.length - 1;
}

/* =========================================================
   FORMAT SYSTEM — Theme / Layout Configuration
   To add a new formatting option:
   1. Add default value here in DEFAULT_FORMAT
   2. Add it to generateFormatCSS()
   3. Add a UI control in renderFormatDrawer()
   ========================================================= */

var DEFAULT_FORMAT = {
  densityMode:    'balanced',
  fontFamily:     'Times New Roman',
  fontSize:       { name: 22, heading: 11, subheading: 12, body: 11 },
  fontWeight:     { name: 700, heading: 700, subheading: 600, body: 400 },
  fontStyle:      { name: false, heading: false },
  textDecoration: { heading: false },
  lineSpacing:    1.15,
  sectionSpacing: 'normal',
  bulletSpacing:  'normal',
  pageSize:       'A4',
  pageMargins:    'normal',
  customMargins:  { top: 24, bottom: 24, left: 28, right: 28 },
  headingColor:   '#111111',
  accentColor:    '#2563eb',
  linkColor:      '#1d4ed8',
  boldProjectTitle:  true,
  italicCompanyName: false,
  underlineLinks:    false
};

var DENSITY_PRESETS = {
  compact: {
    lineSpacing: 1.0, sectionSpacing: 'compact', bulletSpacing: 'compact',
    pageMargins: 'narrow',
    fontSize: { name: 19, heading: 10, subheading: 11, body: 10 }
  },
  balanced: {
    lineSpacing: 1.15, sectionSpacing: 'normal', bulletSpacing: 'normal',
    pageMargins: 'normal',
    fontSize: { name: 22, heading: 11, subheading: 12, body: 11 }
  },
  comfortable: {
    lineSpacing: 1.5, sectionSpacing: 'spacious', bulletSpacing: 'spacious',
    pageMargins: 'wide',
    fontSize: { name: 24, heading: 12, subheading: 13, body: 12 }
  }
};

/* Lighten or darken a hex color by `amount` (-255 to 255) */
function adjustColor(hex, amount) {
  hex = String(hex).replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function(c){ return c + c; }).join('');
  if (hex.length !== 6) return '#111';
  var r = Math.min(255, Math.max(0, parseInt(hex.substr(0, 2), 16) + amount));
  var g = Math.min(255, Math.max(0, parseInt(hex.substr(2, 2), 16) + amount));
  var b = Math.min(255, Math.max(0, parseInt(hex.substr(4, 2), 16) + amount));
  return '#' + [r, g, b].map(function(v) { return ('0' + v.toString(16)).slice(-2); }).join('');
}

/* Generate override CSS from the format config.
   All rules target #resumePreview so they never affect app UI. */
function generateFormatCSS(fmt) {
  var P   = '#resumePreview ';
  var css = '';

  /* Margin lookup */
  var marginMap = { narrow: '12px 16px', normal: '24px 28px', wide: '36px 44px' };
  var margin = fmt.pageMargins === 'custom'
    ? fmt.customMargins.top + 'px ' + fmt.customMargins.right + 'px ' + fmt.customMargins.bottom + 'px ' + fmt.customMargins.left + 'px'
    : (marginMap[fmt.pageMargins] || '24px 28px');

  var sidePad = fmt.pageMargins === 'narrow' ? '16px'
              : fmt.pageMargins === 'wide'   ? '44px'
              : '28px';

  /* Base font & line height */
  css += '#resumePreview {\n';
  css += '  font-family: "' + fmt.fontFamily + '", "Times New Roman", serif;\n';
  css += '  line-height: ' + fmt.lineSpacing + ';\n';
  css += '}\n';

  /* Padding — ATS Classic and Corporate take full padding */
  css += '#resumePreview.tpl-ats, #resumePreview.tpl-corp { padding: ' + margin + '; }\n';

  /* Modern Blue: only body padding; header keeps its own horizontal pad */
  css += P + '.tpl-mod-header {\n';
  css += '  padding-left: '  + sidePad + ';\n';
  css += '  padding-right: ' + sidePad + ';\n';
  css += '}\n';
  css += P + '.tpl-mod-body { padding: 16px ' + sidePad + '; }\n';

  /* Name */
  var NT = P + '.tpl-ats-name, ' + P + '.tpl-mod-name, ' + P + '.tpl-corp-name';
  css += NT + ' {\n';
  css += '  font-size: '   + fmt.fontSize.name   + 'px;\n';
  css += '  font-weight: ' + fmt.fontWeight.name + ';\n';
  if (fmt.fontStyle.name) css += '  font-style: italic;\n';
  css += '}\n';

  /* Section headings */
  var HT = P + '.tpl-ats-title, ' + P + '.tpl-corp-title';
  css += HT + ' {\n';
  css += '  font-size: '   + fmt.fontSize.heading   + 'px;\n';
  css += '  font-weight: ' + fmt.fontWeight.heading + ';\n';
  css += '  color: '       + fmt.headingColor       + ';\n';
  if (fmt.fontStyle.heading)      css += '  font-style: italic;\n';
  if (fmt.textDecoration.heading) css += '  text-decoration: underline;\n';
  css += '}\n';

  /* Modern Blue heading uses accentColor, not headingColor */
  css += P + '.tpl-mod-title {\n';
  css += '  font-size: '   + fmt.fontSize.heading   + 'px;\n';
  css += '  font-weight: ' + fmt.fontWeight.heading + ';\n';
  css += '  color: ' + fmt.accentColor + ';\n';
  css += '}\n';

  /* Subheadings (entry strong titles) */
  var ST = P + '.tpl-ats-entry-row strong, '
    + P + '.tpl-mod-entry-name, '
    + P + '.tpl-corp-entry-main';
  css += ST + ' {\n';
  css += '  font-size: '   + fmt.fontSize.subheading + 'px;\n';
  css += '  font-weight: ' + (fmt.boldProjectTitle ? 700 : fmt.fontWeight.subheading) + ';\n';
  if (fmt.italicCompanyName) css += '  font-style: italic;\n';
  css += '}\n';

  /* Body text */
  var BT = P + '.tpl-ats-body, ' + P + '.tpl-ats-entry-desc, ' + P + '.tpl-ats-entry-sub, '
    + P + '.tpl-mod-text, ' + P + '.tpl-mod-entry-sub, '
    + P + '.tpl-corp-body, ' + P + '.tpl-corp-entry-sub, '
    + P + '.tpl-ats-list li, ' + P + '.tpl-mod-list li, ' + P + '.tpl-corp-list li';
  css += BT + ' {\n';
  css += '  font-size: '   + fmt.fontSize.body   + 'px;\n';
  css += '  font-weight: ' + fmt.fontWeight.body + ';\n';
  css += '}\n';

  /* Contact text: one smaller than body */
  var CT = P + '.tpl-ats-contact, ' + P + '.tpl-corp-contact, ' + P + '.tpl-mod-contact';
  css += CT + ' { font-size: ' + Math.max(9, fmt.fontSize.body - 1) + 'px; }\n';

  /* Section spacing */
  var ssMap = { compact: '8px', normal: '14px', spacious: '22px' };
  var ss = ssMap[fmt.sectionSpacing] || '14px';
  css += P + '.tpl-ats-section, ' + P + '.tpl-mod-section, ' + P + '.tpl-corp-section { margin-bottom: ' + ss + '; }\n';

  /* Bullet spacing */
  var bsMap = { compact: '1px', normal: '3px', spacious: '7px' };
  var bs = bsMap[fmt.bulletSpacing] || '3px';
  css += P + '.tpl-ats-list li, ' + P + '.tpl-mod-list li, ' + P + '.tpl-corp-list li { margin-bottom: ' + bs + '; }\n';

  /* Accent color — Modern Blue */
  css += P + '.tpl-mod-header { background: linear-gradient(135deg, ' + adjustColor(fmt.accentColor, -35) + ', ' + fmt.accentColor + '); }\n';
  css += P + '.tpl-mod-badge  { color: ' + fmt.accentColor + '; background: ' + fmt.accentColor + '1a; }\n';
  css += P + '.tpl-mod-entry  { border-left-color: ' + fmt.accentColor + '55; }\n';
  css += P + '.tpl-mod-skill  { color: ' + fmt.accentColor + '; border-color: ' + fmt.accentColor + '55; background: ' + fmt.accentColor + '0f; }\n';

  /* Accent color — Corporate */
  css += P + '.tpl-corp-accent-bar { background: linear-gradient(to right, ' + adjustColor(fmt.accentColor, -25) + ', ' + fmt.accentColor + '); }\n';
  css += P + '.tpl-corp-rule  { border-top-color: ' + fmt.accentColor + '; }\n';
  css += P + '.tpl-corp-skill { border-color: ' + fmt.accentColor + '; background: ' + fmt.accentColor + '0f; }\n';

  /* ATS Classic rules use heading color */
  css += P + '.tpl-ats-rule-full { border-top-color: ' + fmt.headingColor + '; }\n';
  css += P + '.tpl-ats-rule      { border-top-color: ' + fmt.headingColor + '88; }\n';

  /* Hyperlinks */
  css += P + 'a { color: ' + fmt.linkColor + '; text-decoration: ' + (fmt.underlineLinks ? 'underline' : 'none') + '; }\n';
  css += P + 'a:hover { opacity: 0.75; text-decoration: underline; }\n';

  return css;
}

/* Inject/update the format <style> element */
function applyFormatToPreview(fmt) {
  var el = document.getElementById('resumeFormatStyle');
  if (!el) {
    el = document.createElement('style');
    el.id = 'resumeFormatStyle';
    document.head.appendChild(el);
  }
  el.textContent = generateFormatCSS(fmt || DEFAULT_FORMAT);
}

/* Safe HTML escaping — prevents XSS from user-typed resume content */
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---- Defensive plain-text sanitizer ----
   Resume data must ALWAYS be plain text, never HTML -- this is what
   heals any resume saved by the older, now-removed implementation
   that stored raw HTML (<span style=...>, <b>, etc) directly inside
   the text fields themselves. Strips only tags from our known
   formatting vocabulary (so an incidental "<" in genuine content,
   e.g. "score < 50", is left alone), repeating until nothing more
   matches in case corruption had nested/duplicated across edits. */
function stripHtmlToPlainText(str) {
  if (!str) return '';
  var s = String(str);
  var prev;
  do {
    prev = s;
    s = s.replace(/<\/?(b|strong|i|em|u|s|strike|span|a|br)\b[^>]*>/gi, '');
  } while (s !== prev);
  return s;
}

/* ---- localStorage helpers ---- */
var TEMPLATE_STORAGE_KEY = "buildresume_selected_template";
var DEFAULT_TEMPLATE_ID  = "ATS_CLASSIC";

function getSelectedTemplate() {
  var saved = localStorage.getItem(TEMPLATE_STORAGE_KEY);
  return (saved && TemplateRegistry[saved]) ? saved : DEFAULT_TEMPLATE_ID;
}

function saveSelectedTemplate(templateId) {
  localStorage.setItem(TEMPLATE_STORAGE_KEY, templateId);
}

/* ---- Toast notification ---- */
function showToast(message, type) {
  type = type || "success";
  var existing = document.getElementById("brToast");
  if (existing) existing.remove();

  var toast = document.createElement("div");
  toast.id = "brToast";
  toast.className = "br-toast br-toast--" + type;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      toast.classList.add("br-toast--visible");
    });
  });

  setTimeout(function () {
    toast.classList.remove("br-toast--visible");
    setTimeout(function () { toast.remove(); }, 300);
  }, 2500);
}

/* ==========================================================
   TEMPLATE REGISTRATIONS
   ========================================================== */

/* ---- 1. ATS Classic ---- */
registerTemplate({
  id: "ATS_CLASSIC",
  name: "ATS Classic",
  description: "Optimized for ATS screening systems",
  cssClass: "tpl-ats",
  category: "ats",
  thumbnailHTML: [
    '<div class="tpl-thumb tpl-thumb-ats">',
      '<span class="th-name">JOHN DOE</span>',
      '<span class="th-contact">john@email.com | +1 234 5678 | City</span>',
      '<span class="th-divider"></span>',
      '<span class="th-section-title">EDUCATION</span>',
      '<span class="th-line w90"></span>',
      '<span class="th-line w70"></span>',
      '<span class="th-section-title">SKILLS</span>',
      '<span class="th-line w100"></span>',
      '<span class="th-section-title">PROJECTS</span>',
      '<span class="th-line w80"></span>',
      '<span class="th-line w60"></span>',
    '</div>'
  ].join(""),

  render: function (vm) {
    var pi  = vm.personalInfo;
    var S   = {};   /* section HTML map — emitted in sectionOrder at the end */
    var html = '';

    /* --- Header (always first) --- */
    var contactParts = [];
    if (pi.email)  contactParts.push(safeMailto(pi.email));
    if (pi.phone)  contactParts.push(safeTel(pi.phone));
    var loc = [pi.city, pi.state, pi.country].filter(Boolean).join(', ');
    if (loc) contactParts.push(escHtml(loc));
    if (pi.linkedin)   contactParts.push(safeLink(pi.linkedin,   'LinkedIn'));
    if (pi.github)     contactParts.push(safeLink(pi.github,     'GitHub'));
    if (pi.leetcode)   contactParts.push(safeLink(pi.leetcode,   'LeetCode'));
    if (pi.portfolio)  contactParts.push(safeLink(pi.portfolio,  'Portfolio'));
    if (pi.codeforces) contactParts.push(safeLink(pi.codeforces, 'Codeforces'));
    if (pi.hackerrank) contactParts.push(safeLink(pi.hackerrank, 'HackerRank'));
    (pi.customLinks || []).forEach(function(cl) {
      if (cl.platform && cl.url) contactParts.push(safeLink(cl.url, cl.platform));
      else if (cl.platform)      contactParts.push(escHtml(cl.platform));
    });

    html += '<div class="tpl-ats-header">';
    html += '<div class="tpl-ats-name" data-br-field="personalInfo.fullName">' + escHtml(pi.fullName || 'YOUR NAME') + '</div>';
    if (contactParts.length) html += '<div class="tpl-ats-contact">' + contactParts.join(' | ') + '</div>';
    html += '<hr class="tpl-ats-rule-full"></div>';

    /* --- Summary --- */
    if (vm.sections.summary && vm.summary && vm.summary.trim()) {
      S.summary = '<div class="tpl-ats-section"><div class="tpl-ats-title">Professional Summary</div>'
        + '<hr class="tpl-ats-rule"><p class="tpl-ats-body"' + rf('summary.text', vm.summary) + '</p></div>';
    }

    /* --- Work Experience --- */
    if (vm.sections.workExperience) {
      var work = (vm.workExperience || []).filter(function(w){ return w.company || w.role; });
      if (work.length) {
        var wHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Work Experience</div><hr class="tpl-ats-rule">';
        work.forEach(function(w) {
          var period = formatPeriod(w.startMonth, w.startYear, w.endMonth, w.endYear, w.currentlyWorking);
          wHtml += '<div class="tpl-ats-entry"><div class="tpl-ats-entry-row">';
          var title = [w.role, w.company].filter(Boolean).map(escHtml).join(', ');
          wHtml += '<strong>' + title + '</strong>';
          if (period) wHtml += '<span class="tpl-ats-year">' + escHtml(period) + '</span>';
          wHtml += '</div>';
          var sub = [w.employmentType, w.location].filter(Boolean).map(escHtml).join(' \u00b7 ');
          if (sub) wHtml += '<div class="tpl-ats-entry-sub">' + sub + '</div>';
          if (w.description) wHtml += '<div class="tpl-ats-entry-desc"' + rf('workExperience[' + w.id + '].description', w.description) + '</div>';
          var resps = (w.responsibilities || []).filter(function(r){ return r.text; });
          if (resps.length) {
            wHtml += '<ul class="tpl-ats-list">';
            resps.forEach(function(r){ wHtml += '<li' + rf('workExperience[' + w.id + '].responsibilities[' + r.id + '].text', r.text) + '</li>'; });
            wHtml += '</ul>';
          }
          wHtml += '</div>';
        });
        S.workExperience = wHtml + '</div>';
      }
    }

    /* --- Education --- */
    if (vm.sections.education) {
      var edu = (vm.education || []).filter(function(e){ return e.degree || e.institution; });
      if (edu.length) {
        var eHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Education</div><hr class="tpl-ats-rule">';
        edu.forEach(function(e) {
          var period = formatPeriod(e.startMonth, e.startYear, e.endMonth, e.endYear, false);
          eHtml += '<div class="tpl-ats-entry"><div class="tpl-ats-entry-row">';
          var deg = [e.degree, e.branch].filter(Boolean).map(escHtml).join(', ');
          eHtml += '<strong>' + (deg || 'Degree') + '</strong>';
          if (period) eHtml += '<span class="tpl-ats-year">' + escHtml(period) + '</span>';
          eHtml += '</div>';
          var inst = [e.institution, e.location].filter(Boolean).map(escHtml).join(' \u00b7 ');
          if (inst) eHtml += '<div class="tpl-ats-entry-sub">' + inst + '</div>';
          if (e.cgpa) eHtml += '<div class="tpl-ats-entry-desc">CGPA / Percentage: ' + escHtml(e.cgpa) + '</div>';
          if (e.description) eHtml += '<div class="tpl-ats-entry-desc">' + escHtml(e.description) + '</div>';
          eHtml += '</div>';
        });
        S.education = eHtml + '</div>';
      }
    }

    /* --- Skills --- */
    if (vm.sections.skills) {
      var cats = (vm.skills || []).filter(function(c){ return c.items && c.items.length; });
      if (cats.length) {
        var skHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Skills</div><hr class="tpl-ats-rule">';
        cats.forEach(function(cat) {
          skHtml += '<p class="tpl-ats-body">';
          if (cat.category) skHtml += '<strong>' + escHtml(cat.category) + ': </strong>';
          skHtml += cat.items.map(function(i){ return escHtml(i.name); }).join(', ') + '</p>';
        });
        S.skills = skHtml + '</div>';
      }
    }

    /* --- Projects --- */
    if (vm.sections.projects) {
      var projs = (vm.projects || []).filter(function(p){ return p.title; });
      if (projs.length) {
        var prHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Projects</div><hr class="tpl-ats-rule">';
        projs.forEach(function(p) {
          var period = formatPeriod(p.startMonth, p.startYear, p.endMonth, p.endYear, p.ongoing);
          prHtml += '<div class="tpl-ats-entry"><div class="tpl-ats-entry-row">';
          prHtml += '<strong>' + escHtml(p.title) + '</strong>';
          if (period) prHtml += '<span class="tpl-ats-year">' + escHtml(period) + '</span>';
          prHtml += '</div>';
          if (p.technologies) prHtml += '<div class="tpl-ats-entry-sub">Tech: ' + escHtml(p.technologies) + '</div>';
          if (p.description)  prHtml += '<div class="tpl-ats-entry-desc"' + rf('projects[' + p.id + '].description', p.description) + '</div>';
          var bullets = (p.bullets || []).filter(function(b){ return b.text; });
          if (bullets.length) {
            prHtml += '<ul class="tpl-ats-list">';
            bullets.forEach(function(b){ prHtml += '<li' + rf('projects[' + p.id + '].bullets[' + b.id + '].text', b.text) + '</li>'; });
            prHtml += '</ul>';
          }
          var atsLinks = [];
          if (p.githubUrl) atsLinks.push(safeLink(p.githubUrl, 'GitHub \u2197'));
          if (p.liveUrl)   atsLinks.push(safeLink(p.liveUrl,   'Live Demo \u2197'));
          if (atsLinks.length) prHtml += '<div class="tpl-ats-entry-desc" style="margin-top:2px;">' + atsLinks.join(' &nbsp;&bull;&nbsp; ') + '</div>';
          prHtml += '</div>';
        });
        S.projects = prHtml + '</div>';
      }
    }

    /* --- Achievements --- */
    if (vm.sections.achievements) {
      var achs = (vm.achievements || []).filter(function(a){ return a.title; });
      if (achs.length) {
        var aHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Achievements</div><hr class="tpl-ats-rule"><ul class="tpl-ats-list">';
        achs.forEach(function(a) {
          aHtml += '<li><strong>' + escHtml(a.title) + '</strong>';
          if (a.date) aHtml += ' (' + escHtml(a.date) + ')';
          if (a.description) aHtml += ' \u2014 <span' + rf('achievements[' + a.id + '].description', a.description) + '</span>';
          if (a.url) aHtml += ' ' + safeLink(a.url, '[Link]');
          aHtml += '</li>';
        });
        S.achievements = aHtml + '</ul></div>';
      }
    }

    /* --- Certifications --- */
    if (vm.sections.certifications) {
      var certs = (vm.certifications || []).filter(function(c){ return c.name; });
      if (certs.length) {
        var cHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Certifications</div><hr class="tpl-ats-rule"><ul class="tpl-ats-list">';
        certs.forEach(function(c) {
          cHtml += '<li><strong>' + escHtml(c.name) + '</strong>';
          if (c.organization) cHtml += ' \u2014 ' + escHtml(c.organization);
          if (c.issueDate)    cHtml += ' (' + escHtml(c.issueDate) + ')';
          if (c.credentialUrl) cHtml += ' ' + safeLink(c.credentialUrl, '[Verify]');
          cHtml += '</li>';
        });
        S.certifications = cHtml + '</ul></div>';
      }
    }

    /* --- Languages --- */
    if (vm.sections.languages) {
      var langs = (vm.languages || []).filter(function(l){ return l.language; });
      if (langs.length) {
        S.languages = '<div class="tpl-ats-section"><div class="tpl-ats-title">Languages</div><hr class="tpl-ats-rule">'
          + '<p class="tpl-ats-body">' + langs.map(function(l){
            return escHtml(l.language) + (l.proficiency ? ' (' + escHtml(l.proficiency) + ')' : '');
          }).join(' &nbsp;\u2022&nbsp; ') + '</p></div>';
      }
    }

    /* --- Extracurricular --- */
    if (vm.sections.extracurricular) {
      var extras = (vm.extracurricular || []).filter(function(e){ return e.activity; });
      if (extras.length) {
        var xHtml = '<div class="tpl-ats-section"><div class="tpl-ats-title">Extracurricular Activities</div><hr class="tpl-ats-rule"><ul class="tpl-ats-list">';
        extras.forEach(function(e) {
          xHtml += '<li><strong>' + escHtml(e.activity) + '</strong>';
          if (e.description) xHtml += ' \u2014 <span' + rf('extracurricular[' + e.id + '].description', e.description) + '</span>';
          xHtml += '</li>';
        });
        S.extracurricular = xHtml + '</ul></div>';
      }
    }

    /* --- Emit sections in user-defined order --- */
    (vm.sectionOrder || Object.keys(S)).forEach(function(key) {
      if (S[key]) html += S[key];
    });

    return html;
  }
});

/* ---- 2. Modern Blue ---- */
registerTemplate({
  id: "MODERN_BLUE",
  name: "Modern Blue",
  description: "Modern professional design with blue accents",
  cssClass: "tpl-modern",
  category: "modern",
  thumbnailHTML: [
    '<div class="tpl-thumb tpl-thumb-modern">',
      '<div class="th-modern-header">',
        '<span class="th-name">JOHN DOE</span>',
        '<span class="th-contact">john@email.com | +1 234 5678</span>',
      "</div>",
      '<div class="th-modern-body">',
        '<span class="th-blue-label">Education</span>',
        '<span class="th-line w90"></span>',
        '<span class="th-line w70"></span>',
        '<span class="th-blue-label">Skills</span>',
        '<div class="th-pills">',
          '<span class="th-pill"></span>',
          '<span class="th-pill"></span>',
          '<span class="th-pill"></span>',
        "</div>",
        '<span class="th-blue-label">Projects</span>',
        '<span class="th-line w80"></span>',
      "</div>",
    "</div>"
  ].join(""),

  render: function (vm) {
    var pi   = vm.personalInfo;
    var S    = {};
    var html = '';

    /* --- Header --- */
    var contactParts = [];
    if (pi.email)      contactParts.push(safeMailto(pi.email));
    if (pi.phone)      contactParts.push(safeTel(pi.phone));
    var loc = [pi.city, pi.state, pi.country].filter(Boolean).join(', ');
    if (loc)           contactParts.push(escHtml(loc));
    if (pi.linkedin)   contactParts.push(safeLink(pi.linkedin,   'LinkedIn'));
    if (pi.github)     contactParts.push(safeLink(pi.github,     'GitHub'));
    if (pi.leetcode)   contactParts.push(safeLink(pi.leetcode,   'LeetCode'));
    if (pi.portfolio)  contactParts.push(safeLink(pi.portfolio,  'Portfolio'));
    (pi.customLinks || []).forEach(function(cl) {
      if (cl.platform && cl.url) contactParts.push(safeLink(cl.url, cl.platform));
    });

    html += '<div class="tpl-mod-header">';
    html += '<div class="tpl-mod-name" data-br-field="personalInfo.fullName">' + escHtml(pi.fullName || 'Your Name') + '</div>';
    if (contactParts.length) html += '<div class="tpl-mod-contact">' + contactParts.join(' &nbsp;|&nbsp; ') + '</div>';
    html += '</div><div class="tpl-mod-body">';

    /* --- Summary --- */
    if (vm.sections.summary && vm.summary && vm.summary.trim()) {
      S.summary = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Summary</div>'
        + '<p class="tpl-mod-text"' + rf('summary.text', vm.summary) + '</p></div>';
    }

    /* --- Work Experience --- */
    if (vm.sections.workExperience) {
      var work = (vm.workExperience || []).filter(function(w){ return w.company || w.role; });
      if (work.length) {
        var wHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Work Experience</div>';
        work.forEach(function(w) {
          var period = formatPeriod(w.startMonth, w.startYear, w.endMonth, w.endYear, w.currentlyWorking);
          wHtml += '<div class="tpl-mod-entry"><div class="tpl-mod-entry-header">';
          var title = [w.role, w.company].filter(Boolean).map(escHtml).join(' \u00b7 ');
          wHtml += '<strong class="tpl-mod-entry-name">' + title + '</strong>';
          if (period) wHtml += '<span class="tpl-mod-badge">' + escHtml(period) + '</span>';
          wHtml += '</div>';
          var sub = [w.employmentType, w.location].filter(Boolean).map(escHtml).join(' \u00b7 ');
          if (sub) wHtml += '<div class="tpl-mod-entry-sub">' + sub + '</div>';
          if (w.description) wHtml += '<p class="tpl-mod-text"' + rf('workExperience[' + w.id + '].description', w.description) + '</p>';
          var resps = (w.responsibilities || []).filter(function(r){ return r.text; });
          if (resps.length) {
            wHtml += '<ul class="tpl-mod-list">';
            resps.forEach(function(r){ wHtml += '<li' + rf('workExperience[' + w.id + '].responsibilities[' + r.id + '].text', r.text) + '</li>'; });
            wHtml += '</ul>';
          }
          wHtml += '</div>';
        });
        S.workExperience = wHtml + '</div>';
      }
    }

    /* --- Education --- */
    if (vm.sections.education) {
      var edu = (vm.education || []).filter(function(e){ return e.degree || e.institution; });
      if (edu.length) {
        var eHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Education</div>';
        edu.forEach(function(e) {
          var period = formatPeriod(e.startMonth, e.startYear, e.endMonth, e.endYear, false);
          eHtml += '<div class="tpl-mod-entry"><div class="tpl-mod-entry-header">';
          var deg = [e.degree, e.branch].filter(Boolean).map(escHtml).join(', ');
          eHtml += '<strong class="tpl-mod-entry-name">' + (deg || 'Degree') + '</strong>';
          if (period) eHtml += '<span class="tpl-mod-badge">' + escHtml(period) + '</span>';
          eHtml += '</div>';
          var inst = [e.institution, e.location].filter(Boolean).map(escHtml).join(' \u00b7 ');
          if (inst) eHtml += '<div class="tpl-mod-entry-sub">' + inst + '</div>';
          if (e.cgpa) eHtml += '<div class="tpl-mod-entry-sub">CGPA: ' + escHtml(e.cgpa) + '</div>';
          eHtml += '</div>';
        });
        S.education = eHtml + '</div>';
      }
    }

    /* --- Skills --- */
    if (vm.sections.skills) {
      var cats = (vm.skills || []).filter(function(c){ return c.items && c.items.length; });
      if (cats.length) {
        var skHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Skills</div>';
        cats.forEach(function(cat) {
          if (cat.category) skHtml += '<div class="tpl-mod-entry-sub" style="font-weight:700;margin-bottom:4px;">' + escHtml(cat.category) + '</div>';
          skHtml += '<div class="tpl-mod-skills">';
          cat.items.forEach(function(i){ skHtml += '<span class="tpl-mod-skill">' + escHtml(i.name) + '</span>'; });
          skHtml += '</div><div style="margin-bottom:8px;"></div>';
        });
        S.skills = skHtml + '</div>';
      }
    }

    /* --- Projects --- */
    if (vm.sections.projects) {
      var projs = (vm.projects || []).filter(function(p){ return p.title; });
      if (projs.length) {
        var prHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Projects</div>';
        projs.forEach(function(p) {
          var period = formatPeriod(p.startMonth, p.startYear, p.endMonth, p.endYear, p.ongoing);
          prHtml += '<div class="tpl-mod-entry"><div class="tpl-mod-entry-header">';
          prHtml += '<strong class="tpl-mod-entry-name">' + escHtml(p.title) + '</strong>';
          if (period) prHtml += '<span class="tpl-mod-badge">' + escHtml(period) + '</span>';
          prHtml += '</div>';
          if (p.technologies) prHtml += '<div class="tpl-mod-entry-sub">' + escHtml(p.technologies) + '</div>';
          if (p.description)  prHtml += '<p class="tpl-mod-text"' + rf('projects[' + p.id + '].description', p.description) + '</p>';
          var bullets = (p.bullets || []).filter(function(b){ return b.text; });
          if (bullets.length) {
            prHtml += '<ul class="tpl-mod-list">';
            bullets.forEach(function(b){ prHtml += '<li' + rf('projects[' + p.id + '].bullets[' + b.id + '].text', b.text) + '</li>'; });
            prHtml += '</ul>';
          }
          var links = [];
          if (p.githubUrl) links.push(safeLink(p.githubUrl, 'GitHub \u2197'));
          if (p.liveUrl)   links.push(safeLink(p.liveUrl,   'Live Demo \u2197'));
          if (links.length) prHtml += '<div style="margin-top:4px;font-size:11px;">' + links.join(' &nbsp; ') + '</div>';
          prHtml += '</div>';
        });
        S.projects = prHtml + '</div>';
      }
    }

    /* --- Achievements --- */
    if (vm.sections.achievements) {
      var achs = (vm.achievements || []).filter(function(a){ return a.title; });
      if (achs.length) {
        var aHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Achievements</div><ul class="tpl-mod-list">';
        achs.forEach(function(a) {
          aHtml += '<li><strong>' + escHtml(a.title) + '</strong>';
          if (a.date) aHtml += ' (' + escHtml(a.date) + ')';
          if (a.description) aHtml += ' \u2014 <span' + rf('achievements[' + a.id + '].description', a.description) + '</span>';
          if (a.url) aHtml += ' ' + safeLink(a.url, '[Link]');
          aHtml += '</li>';
        });
        S.achievements = aHtml + '</ul></div>';
      }
    }

    /* --- Certifications --- */
    if (vm.sections.certifications) {
      var certs = (vm.certifications || []).filter(function(c){ return c.name; });
      if (certs.length) {
        var cHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Certifications</div><ul class="tpl-mod-list">';
        certs.forEach(function(c) {
          cHtml += '<li><strong>' + escHtml(c.name) + '</strong>';
          if (c.organization)  cHtml += ' \u2014 ' + escHtml(c.organization);
          if (c.issueDate)     cHtml += ' (' + escHtml(c.issueDate) + ')';
          if (c.credentialUrl) cHtml += ' ' + safeLink(c.credentialUrl, '[Verify]');
          cHtml += '</li>';
        });
        S.certifications = cHtml + '</ul></div>';
      }
    }

    /* --- Languages --- */
    if (vm.sections.languages) {
      var langs = (vm.languages || []).filter(function(l){ return l.language; });
      if (langs.length) {
        S.languages = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Languages</div>'
          + '<div class="tpl-mod-skills">'
          + langs.map(function(l){
            return '<span class="tpl-mod-skill">' + escHtml(l.language) + (l.proficiency ? ' \u00b7 ' + escHtml(l.proficiency) : '') + '</span>';
          }).join('') + '</div></div>';
      }
    }

    /* --- Extracurricular --- */
    if (vm.sections.extracurricular) {
      var extras = (vm.extracurricular || []).filter(function(e){ return e.activity; });
      if (extras.length) {
        var xHtml = '<div class="tpl-mod-section"><div class="tpl-mod-title"><span class="tpl-mod-accent">\u25ae</span> Extracurricular</div><ul class="tpl-mod-list">';
        extras.forEach(function(e) {
          xHtml += '<li><strong>' + escHtml(e.activity) + '</strong>';
          if (e.description) xHtml += ' \u2014 <span' + rf('extracurricular[' + e.id + '].description', e.description) + '</span>';
          xHtml += '</li>';
        });
        S.extracurricular = xHtml + '</ul></div>';
      }
    }

    /* --- Emit in user-defined order --- */
    (vm.sectionOrder || Object.keys(S)).forEach(function(key) {
      if (S[key]) html += S[key];
    });

    html += '</div>'; /* close tpl-mod-body */
    return html;
  }
});

/* ---- 3. Corporate ---- */
registerTemplate({
  id: "CORPORATE",
  name: "Corporate",
  description: "Executive style resume for senior professional roles",
  cssClass: "tpl-corp",
  category: "professional",
  thumbnailHTML: [
    '<div class="tpl-thumb tpl-thumb-corp">',
      '<span class="th-corp-name">JOHN DOE</span>',
      '<span class="th-corp-accent-line"></span>',
      '<span class="th-contact" style="color:#555;">john@email.com | +1 234 5678 | City</span>',
      '<span class="th-corp-section">Education</span>',
      '<span class="th-corp-rule"></span>',
      '<span class="th-line w90"></span>',
      '<span class="th-line w70"></span>',
      '<span class="th-corp-section">Skills</span>',
      '<span class="th-corp-rule"></span>',
      '<span class="th-line w80"></span>',
    "</div>"
  ].join(""),

  render: function (vm) {
    var pi   = vm.personalInfo;
    var S    = {};
    var html = '';

    /* --- Header --- */
    var contactParts = [];
    if (pi.email)      contactParts.push(safeMailto(pi.email));
    if (pi.phone)      contactParts.push(safeTel(pi.phone));
    var loc = [pi.city, pi.state, pi.country].filter(Boolean).join(', ');
    if (loc)           contactParts.push(escHtml(loc));
    if (pi.linkedin)   contactParts.push(safeLink(pi.linkedin,   'LinkedIn'));
    if (pi.github)     contactParts.push(safeLink(pi.github,     'GitHub'));
    if (pi.portfolio)  contactParts.push(safeLink(pi.portfolio,  'Portfolio'));
    (pi.customLinks || []).forEach(function(cl) {
      if (cl.platform && cl.url) contactParts.push(safeLink(cl.url, cl.platform));
    });

    html += '<div class="tpl-corp-header">';
    html += '<div class="tpl-corp-name" data-br-field="personalInfo.fullName">' + escHtml((pi.fullName || 'YOUR NAME').toUpperCase()) + '</div>';
    html += '<div class="tpl-corp-accent-bar"></div>';
    if (contactParts.length) html += '<div class="tpl-corp-contact">' + contactParts.join(' &nbsp;\u2022&nbsp; ') + '</div>';
    html += '</div>';

    /* --- Summary --- */
    if (vm.sections.summary && vm.summary && vm.summary.trim()) {
      S.summary = '<div class="tpl-corp-section"><div class="tpl-corp-title">Professional Summary</div>'
        + '<hr class="tpl-corp-rule"><p class="tpl-corp-body"' + rf('summary.text', vm.summary) + '</p></div>';
    }

    /* --- Work Experience --- */
    if (vm.sections.workExperience) {
      var work = (vm.workExperience || []).filter(function(w){ return w.company || w.role; });
      if (work.length) {
        var wHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Professional Experience</div><hr class="tpl-corp-rule">';
        work.forEach(function(w) {
          var period = formatPeriod(w.startMonth, w.startYear, w.endMonth, w.endYear, w.currentlyWorking);
          wHtml += '<div class="tpl-corp-entry"><div class="tpl-corp-entry-left">';
          if (w.role) wHtml += '<div class="tpl-corp-entry-main">' + escHtml(w.role) + '</div>';
          var sub = [w.company, w.employmentType, w.location].filter(Boolean).map(escHtml).join(' \u00b7 ');
          if (sub) wHtml += '<div class="tpl-corp-entry-sub">' + sub + '</div>';
          if (w.description) wHtml += '<div class="tpl-corp-body" style="margin-top:4px;"' + rf('workExperience[' + w.id + '].description', w.description) + '</div>';
          var resps = (w.responsibilities || []).filter(function(r){ return r.text; });
          if (resps.length) {
            wHtml += '<ul class="tpl-corp-list">';
            resps.forEach(function(r){ wHtml += '<li' + rf('workExperience[' + w.id + '].responsibilities[' + r.id + '].text', r.text) + '</li>'; });
            wHtml += '</ul>';
          }
          wHtml += '</div>';
          if (period) wHtml += '<div class="tpl-corp-entry-right">' + escHtml(period) + '</div>';
          wHtml += '</div>';
        });
        S.workExperience = wHtml + '</div>';
      }
    }

    /* --- Education --- */
    if (vm.sections.education) {
      var edu = (vm.education || []).filter(function(e){ return e.degree || e.institution; });
      if (edu.length) {
        var eHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Education</div><hr class="tpl-corp-rule">';
        edu.forEach(function(e) {
          var period = formatPeriod(e.startMonth, e.startYear, e.endMonth, e.endYear, false);
          eHtml += '<div class="tpl-corp-entry"><div class="tpl-corp-entry-left">';
          var deg = [e.degree, e.branch].filter(Boolean).map(escHtml).join(', ');
          if (deg) eHtml += '<div class="tpl-corp-entry-main">' + deg + '</div>';
          var inst = [e.institution, e.location].filter(Boolean).map(escHtml).join(' \u00b7 ');
          if (inst) eHtml += '<div class="tpl-corp-entry-sub">' + inst + '</div>';
          if (e.cgpa) eHtml += '<div class="tpl-corp-entry-sub">CGPA: ' + escHtml(e.cgpa) + '</div>';
          eHtml += '</div>';
          if (period) eHtml += '<div class="tpl-corp-entry-right">' + escHtml(period) + '</div>';
          eHtml += '</div>';
        });
        S.education = eHtml + '</div>';
      }
    }

    /* --- Skills --- */
    if (vm.sections.skills) {
      var cats = (vm.skills || []).filter(function(c){ return c.items && c.items.length; });
      if (cats.length) {
        var skHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Skills</div><hr class="tpl-corp-rule">';
        cats.forEach(function(cat) {
          skHtml += '<p class="tpl-corp-body" style="margin-bottom:5px;">';
          if (cat.category) skHtml += '<strong>' + escHtml(cat.category) + ': </strong>';
          skHtml += cat.items.map(function(i){ return escHtml(i.name); }).join(', ') + '</p>';
        });
        S.skills = skHtml + '</div>';
      }
    }

    /* --- Projects --- */
    if (vm.sections.projects) {
      var projs = (vm.projects || []).filter(function(p){ return p.title; });
      if (projs.length) {
        var prHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Projects</div><hr class="tpl-corp-rule">';
        projs.forEach(function(p) {
          var period = formatPeriod(p.startMonth, p.startYear, p.endMonth, p.endYear, p.ongoing);
          prHtml += '<div class="tpl-corp-entry"><div class="tpl-corp-entry-left">';
          prHtml += '<div class="tpl-corp-entry-main">' + escHtml(p.title) + '</div>';
          if (p.technologies) prHtml += '<div class="tpl-corp-entry-sub">' + escHtml(p.technologies) + '</div>';
          if (p.description)  prHtml += '<div class="tpl-corp-body" style="margin-top:4px;"' + rf('projects[' + p.id + '].description', p.description) + '</div>';
          var bullets = (p.bullets || []).filter(function(b){ return b.text; });
          if (bullets.length) {
            prHtml += '<ul class="tpl-corp-list">';
            bullets.forEach(function(b){ prHtml += '<li' + rf('projects[' + p.id + '].bullets[' + b.id + '].text', b.text) + '</li>'; });
            prHtml += '</ul>';
          }
          var links = [];
          if (p.githubUrl) links.push(safeLink(p.githubUrl, 'GitHub'));
          if (p.liveUrl)   links.push(safeLink(p.liveUrl,   'Live Demo'));
          if (links.length) prHtml += '<div style="font-size:11.5px;margin-top:3px;">' + links.join(' &nbsp;\u2022&nbsp; ') + '</div>';
          prHtml += '</div>';
          if (period) prHtml += '<div class="tpl-corp-entry-right">' + escHtml(period) + '</div>';
          prHtml += '</div>';
        });
        S.projects = prHtml + '</div>';
      }
    }

    /* --- Achievements --- */
    if (vm.sections.achievements) {
      var achs = (vm.achievements || []).filter(function(a){ return a.title; });
      if (achs.length) {
        var aHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Achievements</div><hr class="tpl-corp-rule"><ul class="tpl-corp-list">';
        achs.forEach(function(a) {
          aHtml += '<li><strong>' + escHtml(a.title) + '</strong>';
          if (a.date) aHtml += ' (' + escHtml(a.date) + ')';
          if (a.description) aHtml += ' \u2014 <span' + rf('achievements[' + a.id + '].description', a.description) + '</span>';
          if (a.url) aHtml += ' ' + safeLink(a.url, '[Link]');
          aHtml += '</li>';
        });
        S.achievements = aHtml + '</ul></div>';
      }
    }

    /* --- Certifications --- */
    if (vm.sections.certifications) {
      var certs = (vm.certifications || []).filter(function(c){ return c.name; });
      if (certs.length) {
        var cHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Certifications</div><hr class="tpl-corp-rule"><ul class="tpl-corp-list">';
        certs.forEach(function(c) {
          cHtml += '<li><strong>' + escHtml(c.name) + '</strong>';
          if (c.organization)  cHtml += ' \u2014 ' + escHtml(c.organization);
          if (c.issueDate)     cHtml += ' (' + escHtml(c.issueDate) + ')';
          if (c.credentialUrl) cHtml += ' ' + safeLink(c.credentialUrl, '[Verify]');
          cHtml += '</li>';
        });
        S.certifications = cHtml + '</ul></div>';
      }
    }

    /* --- Languages --- */
    if (vm.sections.languages) {
      var langs = (vm.languages || []).filter(function(l){ return l.language; });
      if (langs.length) {
        S.languages = '<div class="tpl-corp-section"><div class="tpl-corp-title">Languages</div><hr class="tpl-corp-rule">'
          + '<div class="tpl-corp-skills">'
          + langs.map(function(l){
            return '<span class="tpl-corp-skill">' + escHtml(l.language) + (l.proficiency ? ' \u00b7 ' + escHtml(l.proficiency) : '') + '</span>';
          }).join('') + '</div></div>';
      }
    }

    /* --- Extracurricular --- */
    if (vm.sections.extracurricular) {
      var extras = (vm.extracurricular || []).filter(function(e){ return e.activity; });
      if (extras.length) {
        var xHtml = '<div class="tpl-corp-section"><div class="tpl-corp-title">Extracurricular</div><hr class="tpl-corp-rule"><ul class="tpl-corp-list">';
        extras.forEach(function(e) {
          xHtml += '<li><strong>' + escHtml(e.activity) + '</strong>';
          if (e.description) xHtml += ' \u2014 <span' + rf('extracurricular[' + e.id + '].description', e.description) + '</span>';
          xHtml += '</li>';
        });
        S.extracurricular = xHtml + '</ul></div>';
      }
    }

    /* --- Emit in user-defined order --- */
    (vm.sectionOrder || Object.keys(S)).forEach(function(key) {
      if (S[key]) html += S[key];
    });

    return html;
  }
});

/* =========================================================
   NAVIGATION & PAGE SYSTEM
   ========================================================= */

/* =========================================================
   BRAND COMPONENT
   Call renderBrand(containerId, options) to stamp the
   logo + wordmark into any element on any page.

   options = {
     dark: false      // true = dark wordmark (for white backgrounds)
     showTagline: true
   }
   ========================================================= */
function renderBrand(containerId, options) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const opts = Object.assign({ dark: false, showTagline: true }, options);

  /* Real BuildResume logo.
     File location: assets/logo.png (place next to index.html)
     If you ever move the asset, update only this one path.              */
  const logoMarkSVG = `<img src="assets/logo.png" alt="BuildResume logo">`;

  const taglineHTML = opts.showTagline
    ? `<span class="brand-tagline">AI Resume Builder</span>`
    : "";

  container.innerHTML = `
    <a href="#" class="brand ${opts.dark ? "brand--dark" : ""}"
       onclick="navigateTo('home'); return false;"
       aria-label="BuildResume - Go to home">
      <div class="brand-logo">${logoMarkSVG}</div>
      <div class="brand-wordmark">
        <span class="brand-name">BuildResume</span>
        ${taglineHTML}
      </div>
    </a>`;
}

/* --- Mock Data --- */
const mockResumes = [
  { id: 1, title: "Software Engineer Resume",  updated: "June 28, 2025" },
  { id: 2, title: "Frontend Developer Resume", updated: "June 15, 2025" },
  { id: 3, title: "Internship Application",    updated: "May 30, 2025"  }
];

const mockTemplates = {
  ats: [
    { id: "ats-1", name: "ATS Classic"   },
    { id: "ats-2", name: "ATS Clean"     },
    { id: "ats-3", name: "ATS Minimal"   }
  ],
  modern: [
    { id: "mod-1", name: "Modern Blue"   },
    { id: "mod-2", name: "Modern Dark"   },
    { id: "mod-3", name: "Modern Split"  }
  ],
  professional: [
    { id: "pro-1", name: "Executive"     },
    { id: "pro-2", name: "Corporate"     },
    { id: "pro-3", name: "Formal"        }
  ]
};

/* --- Page Navigation --- */
let currentPage = "home";

/* Pages that require a logged-in session. Everything else (login,
   register, otp-verify) is public. */
const PROTECTED_PAGES = ["home", "builder", "templates", "profile"];
const AUTH_ONLY_PAGES = ["login", "register", "otp-verify"];

/* Remembers where the user was actually trying to go, so a login
   redirects back to it afterwards instead of always landing on Home. */
let pendingRedirectPage = null;

function navigateTo(pageName) {
  // ---- Route protection ----
  if (PROTECTED_PAGES.indexOf(pageName) !== -1 && !hasStoredSession()) {
    pendingRedirectPage = pageName;
    pageName = "login";
  } else if (AUTH_ONLY_PAGES.indexOf(pageName) !== -1 && hasStoredSession() && pageName !== "otp-verify") {
    // Already logged in and trying to visit login/register directly ->
    // send them to Home instead. otp-verify is exempt: it's reached
    // mid-flow, before verification completes the login/registration.
    pageName = "home";
  }

  updateNavVisibility(PROTECTED_PAGES.indexOf(pageName) !== -1);
  var decorEl = document.getElementById("authBackgroundDecor");
  if (decorEl) decorEl.style.display = AUTH_ONLY_PAGES.indexOf(pageName) !== -1 ? "block" : "none";

  // Hide all pages
  document.querySelectorAll(".page").forEach(function (p) {
    p.style.display = "none";
  });

  // Show target page
  const target = document.getElementById("page-" + pageName);
  if (!target) return;
  target.style.display = "block";

  // Update nav links
  document.querySelectorAll(".nav-link[data-page]").forEach(function (link) {
    link.classList.toggle("active", link.dataset.page === pageName);
  });

  currentPage = pageName;

  // Update browser tab title per page
  const pageTitles = {
    home:      "BuildResume - My Resumes",
    builder:   "BuildResume - Resume Builder",
    templates: "BuildResume - Templates",
    profile:   "BuildResume - My Profile",
    login:     "BuildResume - Log In",
    register:  "BuildResume - Create Account",
    "otp-verify": "BuildResume - Verify Code"
  };
  document.title = pageTitles[pageName] || "BuildResume";

  // Render page-specific content
  if (pageName === "home")      renderHomePage();
  if (pageName === "templates") renderTemplatesPage();
  if (pageName === 'builder') {
    setTimeout(initBuilder, 0);
  }

  // Close mobile nav if open
  document.getElementById("navbarNav").classList.remove("open");
}

/* Shows/hides the top nav bar entirely based on auth state -- there's
   no reason an unauthenticated visitor should see Home/Builder/
   Templates/Profile/Logout links at all. */
function updateNavVisibility(isAuthenticated) {
  var header = document.getElementById("appHeader");
  if (header) header.style.display = isAuthenticated ? "" : "none";
}

/* --- Home Page --- */
async function renderHomePage() {
  var grid = document.getElementById('resumeGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty-state"><span>\u23F3</span>Loading your resumes...</div>';

  var resumes;
  try {
    resumes = await getResumes();
  } catch (err) {
    grid.innerHTML = '<div class="empty-state">'
      + '<span>\u26A0\uFE0F</span>' + escHtml(describeResumeApiError(err, 'load'))
      + '<br><button class="btn-secondary" onclick="renderHomePage()" style="margin-top:10px;">Retry</button>'
      + '</div>';
    return;
  }

  if (!resumes.length) {
    grid.innerHTML = '<div class="empty-state"><span>\uD83D\uDCC4</span>'
      + 'No resumes yet.<br>Click &ldquo;+ Create New Resume&rdquo; to get started.</div>';
    return;
  }

  grid.innerHTML = '';
  resumes.slice().reverse().forEach(function(resume) {
    var selectedTemplateKey = (resume.resume_data && resume.resume_data.selectedTemplate) || '';
    var tpl  = TemplateRegistry[selectedTemplateKey];
    var d    = new Date(resume.updated_at);
    var card = document.createElement('div');
    card.className = 'resume-card';
    card.innerHTML =
      '<div class="resume-card-title">\uD83D\uDCC4 ' + escHtml(resume.title) + '</div>'
      + '<div class="resume-card-meta">Template: ' + escHtml(tpl ? tpl.name : (selectedTemplateKey || 'Unknown')) + '</div>'
      + '<div class="resume-card-meta">Modified: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString() + '</div>'
      + '<div class="resume-card-actions">'
      + '<button class="btn-edit" onclick="editResume(\'' + resume.id + '\')">\u270F Edit</button>'
      + '<button class="btn-duplicate" onclick="duplicateResume(\'' + resume.id + '\')">\u29C9 Duplicate</button>'
      + '<button class="btn-delete" onclick="confirmDeleteResume(\'' + resume.id + '\',\'' + escHtml(resume.title) + '\')">\uD83D\uDDD1 Delete</button>'
      + '</div>';
    grid.appendChild(card);
  });
}

function editResume(resumeId) {
  setCurrentResumeId(resumeId);
  navigateTo('builder');
}

function confirmDeleteResume(resumeId, name) {
  if (confirm('Delete "' + name + '"? This cannot be undone.')) {
    deleteResume(resumeId);
  }
}

/* --- Templates Page --- */
function renderTemplatesPage() {
  // Map each grid section to the template IDs that belong to it.
  // To add a new template to a section, just push its ID here.
  renderTemplateGrid("atsGrid",          ["ATS_CLASSIC"]);
  renderTemplateGrid("modernGrid",       ["MODERN_BLUE"]);
  renderTemplateGrid("professionalGrid", ["CORPORATE"]);
}

function renderTemplateGrid(containerId, templateIds) {
  var grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = "";

  var activeId = getSelectedTemplate();

  templateIds.forEach(function (id) {
    var tpl = TemplateRegistry[id];
    if (!tpl) return;

    var isActive = activeId === id;

    var card = document.createElement("div");
    card.className = "template-card";

    var badgeHTML   = isActive ? '<span class="tpl-active-badge">Active</span>' : "";
    var btnClass    = isActive ? "template-apply-btn template-apply-btn--applied" : "template-apply-btn";
    var btnLabel    = isActive ? "Applied ✓" : "Apply";

    card.innerHTML =
      '<div class="template-thumbnail">' + tpl.thumbnailHTML + "</div>" +
      '<div class="template-card-info">' +
        "<div>" +
          '<div class="template-card-name">' + escHtml(tpl.name) + badgeHTML + "</div>" +
          '<div class="template-card-desc">' + escHtml(tpl.description) + "</div>" +
        "</div>" +
        '<button class="' + btnClass + '" onclick="applyTemplate(\'' + id + '\')">' + btnLabel + "</button>" +
      "</div>";

    grid.appendChild(card);
  });
}

function applyTemplate(templateId) {
  if (!TemplateRegistry[templateId]) {
    showToast("Unknown template.", "error");
    return;
  }
  saveSelectedTemplate(templateId);
  showToast("Template Applied Successfully ✓");
  // Brief delay so the user sees the toast before the page switches
  setTimeout(function () {
    navigateTo("builder");
  }, 700);
}

/* --- Logout Modal --- */
function openLogoutModal() {
  document.getElementById("logoutModal").classList.add("open");
}

function closeLogoutModal() {
  document.getElementById("logoutModal").classList.remove("open");
}

async function performLogout() {
  var confirmBtn = document.getElementById("confirmLogout");
  var originalLabel = confirmBtn.textContent;
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Logging out...";

  await logoutUser(); // always clears local tokens itself, even on failure

  confirmBtn.disabled = false;
  confirmBtn.textContent = originalLabel;
  closeLogoutModal();
  showToast("Logged out successfully.", "success");
  navigateTo("login");
}

/* --- Hamburger Menu --- */
function initNavbar() {
  // Mount the reusable Brand component into the navbar slot
  renderBrand("navbarBrand", { dark: false, showTagline: true });

  // Ensure browser tab always reads "BuildResume"
  document.title = "BuildResume - AI Resume Builder";

  // Wire nav links
  document.querySelectorAll(".nav-link[data-page]").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      navigateTo(link.dataset.page);
    });
  });

  // Wire logout button
  document.getElementById("logoutBtn").addEventListener("click", function (e) {
    e.preventDefault();
    openLogoutModal();
  });

  // Wire modal buttons
  document.getElementById("cancelLogout").addEventListener("click", closeLogoutModal);
  document.getElementById("confirmLogout").addEventListener("click", function () {
    performLogout();
  });

  // Close modal on overlay click
  document.getElementById("logoutModal").addEventListener("click", function (e) {
    if (e.target === this) closeLogoutModal();
  });

  // Hamburger toggle
  document.getElementById("hamburgerBtn").addEventListener("click", function () {
    document.getElementById("navbarNav").classList.toggle("open");
  });

  // Close mobile menu on outside click
  document.addEventListener("click", function (e) {
    const nav = document.getElementById("navbarNav");
    const btn = document.getElementById("hamburgerBtn");
    if (!nav.contains(e.target) && !btn.contains(e.target)) {
      nav.classList.remove("open");
    }
  });
}

/* =========================================================
   RESUME DATA MODEL & STORAGE
   ========================================================= */

/* Only holds a pointer (which resume is open in the builder right
   now), never resume content -- all actual resume data lives in
   Postgres and is only ever read/written via getResume()/
   getResumes()/createResume()/updateResume()/deleteResumeApi(). */
var RESUME_STORAGE_KEYS = {
  CURRENT_ID: 'buildresume_current_resume_id'
};

function generateId() {
  return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function createEmptyResume(name) {
  return {
    resumeId:         null, /* set for real once the first save/autosave creates the backend row */
    resumeName:       name || 'Untitled Resume',
    selectedTemplate: getSelectedTemplate(),
    createdDate:      new Date().toISOString(),
    lastModifiedDate: new Date().toISOString(),
    format:           JSON.parse(JSON.stringify(DEFAULT_FORMAT)),
    formatting:       {},         /* per-field inline formatting metadata — see RICH TEXT FORMATTING MODEL */
    sectionOrder: [
      'summary', 'education', 'skills', 'projects',
      'workExperience', 'achievements', 'certifications',
      'languages', 'extracurricular'
    ],
    sections: {
      summary:         false,
      education:       true,
      skills:          true,
      projects:        true,
      workExperience:  false,
      achievements:    false,
      certifications:  false,
      languages:       false,
      extracurricular: false
    },
    data: {
      personalInfo: {
        fullName: '', email: '', phone: '', address: '',
        city: '', state: '', country: '',
        linkedin: '', github: '', leetcode: '',
        portfolio: '', codeforces: '', hackerrank: '',
        customLinks: []
      },
      summary:         { text: '' },
      education:       [],
      skills:          [],
      projects:        [],
      workExperience:  [],
      achievements:    [],
      certifications:  [],
      languages:       [],
      extracurricular: []
    }
  };
}

/* =========================================================
   BACKEND <-> INTERNAL RESUME SHAPE CONVERSION
   ========================================================= */

var RESUME_CONTENT_KEYS = [
  'personalInfo', 'summary', 'education', 'skills', 'projects',
  'workExperience', 'achievements', 'certifications', 'languages', 'extracurricular'
];

function internalResumeToApiPayload(resume) {
  var resume_data = {};
  RESUME_CONTENT_KEYS.forEach(function (key) {
    resume_data[key] = resume.data ? resume.data[key] : undefined;
  });
  resume_data.format           = resume.format;
  resume_data.sectionOrder     = resume.sectionOrder;
  resume_data.sections         = resume.sections;
  resume_data.selectedTemplate = resume.selectedTemplate;

  return {
    title: resume.resumeName,
    resume_data: resume_data,
    formatting_data: resume.formatting || {}
  };
}

function apiResumeToInternal(apiResume) {
  var rd = (apiResume && apiResume.resume_data) || {};
  var defaults = createEmptyResume().data;
  var data = {};
  RESUME_CONTENT_KEYS.forEach(function (key) {
    data[key] = (rd[key] !== undefined) ? rd[key] : defaults[key];
  });

  return {
    resumeId:         apiResume.id,
    resumeName:       apiResume.title || 'Untitled Resume',
    selectedTemplate: rd.selectedTemplate || getSelectedTemplate(),
    createdDate:      apiResume.created_at,
    lastModifiedDate: apiResume.updated_at,
    format:           rd.format || JSON.parse(JSON.stringify(DEFAULT_FORMAT)),
    formatting:       apiResume.formatting_data || {},
    sectionOrder:     (rd.sectionOrder && rd.sectionOrder.length) ? rd.sectionOrder : SECTION_DEFS.map(function(d){ return d.key; }),
    sections:         rd.sections || createEmptyResume().sections,
    data:             data
  };
}

function describeResumeApiError(err, action) {
  if (!err) return 'Something went wrong. Please try again.';
  if (err.status === 0)   return 'Could not reach the server. Check your connection and try again.';
  if (err.status === 401) return 'Your session has expired. Please log in again.';
  if (err.status === 403) return 'You do not have permission to ' + action + ' this resume.';
  if (err.status === 404) return 'This resume could not be found. It may have been deleted.';
  if (err.status >= 500)  return 'The server ran into a problem while trying to ' + action + ' this resume. Please try again shortly.';
  return err.message || ('Failed to ' + action + ' this resume.');
}

function getCurrentResumeId() {
  return localStorage.getItem(RESUME_STORAGE_KEYS.CURRENT_ID) || null;
}

function setCurrentResumeId(id) {
  localStorage.setItem(RESUME_STORAGE_KEYS.CURRENT_ID, id);
}

function clearCurrentResumeId() {
  localStorage.removeItem(RESUME_STORAGE_KEYS.CURRENT_ID);
}

var currentResume = null;

async function loadResumeById(id) {
  try {
    var apiResume = await getResume(id);
    currentResume = apiResumeToInternal(apiResume);
    migrateLegacyHtmlInData(currentResume);
    return currentResume;
  } catch (err) {
    showToast(describeResumeApiError(err, 'open'), 'error');
    return null;
  }
}

function migrateLegacyHtmlInData(resume) {
  var d = resume.data;
  if (!d) return;
  var touched = false;

  function clean(obj, key) {
    if (!obj || obj[key] == null) return;
    var before = obj[key];
    var after  = stripHtmlToPlainText(before);
    if (after !== before) { obj[key] = after; touched = true; }
  }

  if (d.summary) clean(d.summary, 'text');
  (d.workExperience || []).forEach(function (w) {
    clean(w, 'description');
    (w.responsibilities || []).forEach(function (r) { clean(r, 'text'); });
  });
  (d.projects || []).forEach(function (p) {
    clean(p, 'description');
    (p.bullets || []).forEach(function (b) { clean(b, 'text'); });
  });
  (d.achievements || []).forEach(function (a) { clean(a, 'description'); });
  (d.extracurricular || []).forEach(function (e) { clean(e, 'description'); });

  if (touched) {
    resume.formatting = {};
    showToast('Cleaned up some corrupted formatting from an earlier version. Please re-apply any formatting.', 'info');
  }
}

var _saveInProgress = false;

async function saveCurrentResume() {
  if (!currentResume) return;
  if (_saveInProgress) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(saveCurrentResume, 400);
    return;
  }

  _saveInProgress = true;
  currentResume.selectedTemplate = getSelectedTemplate();
  var payload = internalResumeToApiPayload(currentResume);

  try {
    var apiResume;
    if (!currentResume.resumeId) {
      apiResume = await createResume(payload);
      currentResume.resumeId = apiResume.id;
      setCurrentResumeId(apiResume.id);
    } else {
      apiResume = await updateResume(currentResume.resumeId, payload);
    }
    currentResume.createdDate      = apiResume.created_at;
    currentResume.lastModifiedDate = apiResume.updated_at;
    showSaveStatus('saved');
  } catch (err) {
    showSaveStatus('error');
    showToast(describeResumeApiError(err, 'save'), 'error');
  } finally {
    _saveInProgress = false;
  }

  updateBuilderToolbar();
}

async function deleteResume(resumeId) {
  try {
    await deleteResumeApi(resumeId);
  } catch (err) {
    showToast(describeResumeApiError(err, 'delete'), 'error');
    return;
  }

  if (getCurrentResumeId() === resumeId) {
    clearCurrentResumeId();
    currentResume = null;
  }
  showToast('Resume deleted.', 'success');
  renderHomePage();
}

async function duplicateResume(resumeId) {
  var original;
  try {
    original = await getResume(resumeId);
  } catch (err) {
    showToast(describeResumeApiError(err, 'duplicate'), 'error');
    return;
  }

  var copyPayload = {
    title: (original.title || 'Untitled Resume') + ' (Copy)',
    template_id: original.template_id || null,
    resume_data: original.resume_data || {},
    formatting_data: original.formatting_data || {}
  };

  try {
    await createResume(copyPayload);
    showToast('Resume duplicated!', 'success');
    renderHomePage();
  } catch (err) {
    showToast(describeResumeApiError(err, 'duplicate'), 'error');
  }
}

/* =========================================================
   SECTION DEFINITIONS
   To add a new section: push an entry here, add a renderer
   to renderFormSection(), add CSS, update template renders.
   ========================================================= */

var SECTION_DEFS = [
  { key: 'summary',         label: 'Professional Summary', icon: '\uD83D\uDCDD', defaultEnabled: false },
  { key: 'education',       label: 'Education',            icon: '\uD83C\uDF93', defaultEnabled: true  },
  { key: 'skills',          label: 'Skills',               icon: '\u26A1',       defaultEnabled: true  },
  { key: 'projects',        label: 'Projects',             icon: '\uD83D\uDE80', defaultEnabled: true  },
  { key: 'workExperience',  label: 'Work Experience',      icon: '\uD83D\uDCBC', defaultEnabled: false },
  { key: 'achievements',    label: 'Achievements',         icon: '\uD83C\uDFC6', defaultEnabled: false },
  { key: 'certifications',  label: 'Certifications',       icon: '\uD83D\uDCDC', defaultEnabled: false },
  { key: 'languages',       label: 'Languages',            icon: '\uD83C\uDF10', defaultEnabled: false },
  { key: 'extracurricular', label: 'Extracurricular',      icon: '\uD83C\uDFAF', defaultEnabled: false }
];

/* =========================================================
   SECTION MANAGER
   ========================================================= */

var sectionManagerOpen = false;

function toggleSectionManager() {
  sectionManagerOpen = !sectionManagerOpen;
  var panel = document.getElementById('sectionManager');
  var btn   = document.getElementById('sectionManagerBtn');
  if (panel) panel.style.display = sectionManagerOpen ? 'block' : 'none';
  if (btn)   btn.classList.toggle('active', sectionManagerOpen);
  if (sectionManagerOpen) renderSectionManagerList();
}

var _smDragKey = null;

function renderSectionManagerList() {
  var list = document.getElementById('sectionManagerList');
  if (!list || !currentResume) return;

  var order  = currentResume.sectionOrder || SECTION_DEFS.map(function(d){ return d.key; });
  var defMap = {};
  SECTION_DEFS.forEach(function(d){ defMap[d.key] = d; });

  /* Personal Info row — always on, not draggable */
  var html = '<div class="sm-row sm-static">'
    + '<span class="sm-drag-handle" style="visibility:hidden;">\u2630</span>'
    + '<span class="sm-check">\u2611</span>'
    + '<span class="sm-icon">\uD83D\uDC64</span>'
    + '<span class="sm-label">Personal Information</span>'
    + '<span class="sm-badge">Always On</span>'
    + '</div>';

  order.forEach(function(key, idx) {
    var def = defMap[key];
    if (!def) return;
    var on      = currentResume.sections[key];
    var isFirst = idx === 0;
    var isLast  = idx === order.length - 1;

    html += '<div class="sm-row ' + (on ? 'sm-enabled' : '') + '" '
      + 'data-key="' + key + '" '
      + 'draggable="true" '
      + 'ondragstart="smDragStart(event,\'' + key + '\')" '
      + 'ondragover="smDragOver(event,\'' + key + '\')" '
      + 'ondragleave="smDragLeave(event)" '
      + 'ondrop="smDrop(event,\'' + key + '\')" '
      + 'ondragend="smDragEnd()">'
      + '<span class="sm-drag-handle" title="Drag to reorder">\u2630</span>'
      + '<span class="sm-check" onclick="toggleSection(\'' + key + '\')" style="cursor:pointer;">'
      + (on ? '\u2611' : '\u2610') + '</span>'
      + '<span class="sm-icon">' + def.icon + '</span>'
      + '<span class="sm-label" onclick="toggleSection(\'' + key + '\')" style="cursor:pointer;flex:1;">' + def.label + '</span>'
      + '<div class="sm-reorder">'
      + '<button class="sm-reorder-btn" onclick="moveSectionUp(\'' + key + '\')" title="Move up" ' + (isFirst ? 'disabled' : '') + '>\u25B2</button>'
      + '<button class="sm-reorder-btn" onclick="moveSectionDown(\'' + key + '\')" title="Move down" ' + (isLast ? 'disabled' : '') + '>\u25BC</button>'
      + '</div>'
      + '</div>';
  });

  list.innerHTML = html;
}

function moveSectionUp(key) {
  if (!currentResume) return;
  var order = currentResume.sectionOrder;
  var idx   = order.indexOf(key);
  if (idx <= 0) return;
  order.splice(idx, 1);
  order.splice(idx - 1, 0, key);
  renderSectionManagerList();
  renderBuilderForm();
  renderPreview();
  scheduleAutoSave();
}

function moveSectionDown(key) {
  if (!currentResume) return;
  var order = currentResume.sectionOrder;
  var idx   = order.indexOf(key);
  if (idx < 0 || idx >= order.length - 1) return;
  order.splice(idx, 1);
  order.splice(idx + 1, 0, key);
  renderSectionManagerList();
  renderBuilderForm();
  renderPreview();
  scheduleAutoSave();
}

/* ---- Drag & Drop handlers for Section Manager ---- */
function smDragStart(e, key) {
  _smDragKey = key;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', key);
  /* classList update deferred one tick so browser can snapshot the pre-drag appearance */
  setTimeout(function() {
    var el = document.querySelector('.sm-row[data-key="' + key + '"]');
    if (el) el.classList.add('sm-dragging');
  }, 0);
}

function smDragOver(e, key) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (key === _smDragKey) return;
  document.querySelectorAll('.sm-row[data-key]').forEach(function(row) {
    row.classList.toggle('sm-drag-target', row.dataset.key === key);
  });
}

function smDragLeave(e) {
  e.currentTarget.classList.remove('sm-drag-target');
}

function smDrop(e, targetKey) {
  e.preventDefault();
  if (!_smDragKey || _smDragKey === targetKey || !currentResume) { smDragEnd(); return; }

  var order   = currentResume.sectionOrder;
  var fromIdx = order.indexOf(_smDragKey);
  var toIdx   = order.indexOf(targetKey);
  if (fromIdx < 0 || toIdx < 0) { smDragEnd(); return; }

  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, _smDragKey);

  smDragEnd();
  renderSectionManagerList();
  renderBuilderForm();
  renderPreview();
  scheduleAutoSave();
}

function smDragEnd() {
  _smDragKey = null;
  document.querySelectorAll('.sm-row').forEach(function(row) {
    row.classList.remove('sm-dragging', 'sm-drag-target');
  });
}

/* ---------- Resume Preview Rendering ---------- */
function buildViewModel() {
  if (!currentResume) return null;
  // Guarantee every section key is present in the order array (handles old saved resumes)
  var allKeys = SECTION_DEFS.map(function(d){ return d.key; });
  var savedOrder = currentResume.sectionOrder || [];
  var order = savedOrder.concat(allKeys.filter(function(k){ return savedOrder.indexOf(k) === -1; }));

  return {
    sectionOrder:    order,
    personalInfo:    currentResume.data.personalInfo,
    summary:         currentResume.data.summary.text,
    education:       currentResume.data.education,
    skills:          currentResume.data.skills,
    projects:        currentResume.data.projects,
    workExperience:  currentResume.data.workExperience,
    achievements:    currentResume.data.achievements,
    certifications:  currentResume.data.certifications,
    languages:       currentResume.data.languages,
    extracurricular: currentResume.data.extracurricular,
    sections:        currentResume.sections
  };
}

function renderPreview() {
  var container = document.getElementById('resumePreview');
  if (!container) return;

  if (!currentResume) {
    container.className = 'resume-paper';
    container.innerHTML = '<div style="padding:48px 32px;text-align:center;color:#94a3b8;">'
      + '<div style="font-size:40px;margin-bottom:16px;">\uD83D\uDCCB</div>'
      + '<p>No resume loaded.</p>'
      + '<p style="font-size:12px;margin-top:6px;">Create or select a resume to see the preview.</p>'
      + '</div>';
    var bar = document.getElementById('pageIndicatorBar');
    if (bar) bar.style.display = 'none';
    return;
  }

  /* Suspend the MutationObserver so this programmatic innerHTML
     assignment is NOT treated as a user edit. */
  _suspendMutObs = true;

  var selectedId = getSelectedTemplate();
  var template   = TemplateRegistry[selectedId] || TemplateRegistry[DEFAULT_TEMPLATE_ID];

  container.className = 'resume-paper ' + template.cssClass;
  container.innerHTML = template.render(buildViewModel());

  /* Apply saved formatting theme */
  applyFormatToPreview(currentResume.format || DEFAULT_FORMAT);

  /* Keep builder template switcher in sync */
  var switcher = document.getElementById('builderTemplateSwitcher');
  if (switcher && switcher.value !== selectedId) switcher.value = selectedId;

  renderCompletenessBar();
  updatePageIndicator();

  /* Enable content editing — idempotent, safe to call every render */
  makePreviewEditable();

  /* Wire stable document-level listeners — only runs once thanks to the flag */
  initSelectionToolbar();

  /* (Re)connect the MutationObserver to the freshly rendered element */
  setTimeout(function () {
    _suspendMutObs = false;
    initPreviewMutationObserver();
  }, 80);
}

function toggleSection(key) {
  if (!currentResume) return;
  currentResume.sections[key] = !currentResume.sections[key];
  renderSectionManagerList();
  renderBuilderForm();
  scheduleAutoSave();
  renderPreview();
}

/* =========================================================
   FORM RENDERING — SHARED HELPERS
   ========================================================= */

function formField(label, field, value, placeholder, updateFn, inputType, brPath) {
  inputType = inputType || 'text';
  var brAttr = brPath ? ' data-br-form="' + brPath + '"' : '';
  return '<div class="field-wrap"><label>' + label + '</label>'
    + '<input type="' + inputType + '" placeholder="' + placeholder
    + '" value="' + escHtml(value || '') + '"'
    + brAttr
    + ' oninput="' + updateFn + '(\'' + field + '\', this.value)"></div>';
}

function entryField(label, id, field, value, placeholder, updateFn) {
  return '<div class="field-wrap"><label>' + label + '</label>'
    + '<input type="text" placeholder="' + placeholder + '" value="' + escHtml(value || '') + '"'
    + ' oninput="' + updateFn + '(\'' + id + '\',\'' + field + '\',this.value)"></div>';
}

function monthYearPair(label, mField, yField, mVal, yVal, id, updateFn, ongoingOverride) {
  if (ongoingOverride) {
    return '<div class="field-wrap"><label>' + label + '</label>'
      + '<span style="font-size:12px;color:#64748b;padding-top:6px;display:block;">Present</span></div>';
  }
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var mOpts  = '<option value="">Month</option>' + months.map(function(m,i){
    return '<option value="' + (i+1) + '"' + (mVal == i+1 ? ' selected' : '') + '>' + m + '</option>';
  }).join('');
  var now  = new Date().getFullYear();
  var YEAR_RANGE_START = 1950;
  var YEAR_RANGE_END   = now + 20;
  var yOpts = '<option value="">Year</option>' + Array.from({length: YEAR_RANGE_END - YEAR_RANGE_START + 1}, function(_, i){
    var y = YEAR_RANGE_START + i;
    return '<option value="' + y + '"' + (yVal == y ? ' selected' : '') + '>' + y + '</option>';
  }).join('');
  return '<div class="field-wrap"><label>' + label + '</label>'
    + '<div class="inline-input">'
    + '<select onchange="' + updateFn + '(\'' + id + '\',\'' + mField + '\',this.value)">' + mOpts + '</select>'
    + '<select onchange="' + updateFn + '(\'' + id + '\',\'' + yField + '\',this.value)">' + yOpts + '</select>'
    + '</div></div>';
}

function sectionHeader(icon, label, sectionKey) {
  return '<div class="fs-header"><h3 class="fs-title">' + icon + ' ' + label + '</h3>'
    + '<button class="fs-remove-btn" onclick="toggleSection(\'' + sectionKey + '\')" title="Hide section">\u2715</button>'
    + '</div>';
}

/* =========================================================
   FORM RENDERING — PERSONAL INFORMATION
   ========================================================= */

function renderPersonalInfoForm() {
  var container = document.getElementById('form-section-personalInfo');
  if (!container || !currentResume) return;
  var pi = currentResume.data.personalInfo;

  container.innerHTML = '<div class="fs-header">'
    + '<h3 class="fs-title">\uD83D\uDC64 Personal Information</h3></div>'
    + '<div class="fs-body">'
    + '<div class="field-grid field-grid-2">'
    + formField('Full Name', 'fullName', pi.fullName, 'John Doe',        'updatePI', 'text',  'personalInfo.fullName')
    + formField('Email',     'email',    pi.email,    'john@example.com', 'updatePI', 'email', 'personalInfo.email')
    + formField('Phone',     'phone',    pi.phone,    '+91 9876543210',   'updatePI', 'text',  'personalInfo.phone')
    + formField('Address',   'address',  pi.address,  '123 Street',       'updatePI', 'text',  'personalInfo.address')
    + formField('City',      'city',     pi.city,     'New Delhi',        'updatePI', 'text',  'personalInfo.city')
    + formField('State',     'state',    pi.state,    'Delhi',            'updatePI', 'text',  'personalInfo.state')
    + formField('Country',   'country',  pi.country,  'India',            'updatePI', 'text',  'personalInfo.country')
    + '</div>'
    + '<div class="fs-subsection"><h4 class="fs-subtitle">Online Profiles <span class="fs-hint">(all optional)</span></h4>'
    + '<div class="field-grid field-grid-2">'
    + formField('LinkedIn',   'linkedin',   pi.linkedin,   'linkedin.com/in/user',  'updatePI', 'url')
    + formField('GitHub',     'github',     pi.github,     'github.com/user',       'updatePI', 'url')
    + formField('LeetCode',   'leetcode',   pi.leetcode,   'leetcode.com/user',     'updatePI', 'url')
    + formField('Portfolio',  'portfolio',  pi.portfolio,  'yoursite.com',          'updatePI', 'url')
    + formField('Codeforces', 'codeforces', pi.codeforces, 'codeforces.com/user',   'updatePI', 'url')
    + formField('HackerRank', 'hackerrank', pi.hackerrank, 'hackerrank.com/user',   'updatePI', 'url')
    + '</div></div>'
    + '<div class="fs-subsection"><h4 class="fs-subtitle">Custom Links <span class="fs-hint">(optional)</span></h4>'
    + '<div id="customLinksContainer">' + renderCustomLinksHTML(pi.customLinks) + '</div>'
    + '<button class="add-btn" style="margin-top:6px;" onclick="addCustomLink()">+ Add Custom Link</button>'
    + '</div></div>';
}

function updatePI(field, value) {
  if (!currentResume) return;
  currentResume.data.personalInfo[field] = value;
  scheduleAutoSave();
  renderPreview();
}

function renderCustomLinksHTML(links) {
  if (!links || !links.length) return '<p class="fs-empty">No custom links yet.</p>';
  return links.map(function(cl) {
    return '<div class="entry-card custom-link-card" data-id="' + cl.id + '" style="margin-bottom:8px;">'
      + '<div class="field-grid field-grid-2">'
      + '<div class="field-wrap"><label>Platform</label>'
      + '<input type="text" placeholder="e.g. Kaggle" value="' + escHtml(cl.platform || '') + '"'
      + ' oninput="updateCustomLink(\'' + cl.id + '\',\'platform\',this.value)"></div>'
      + '<div class="field-wrap"><label>URL</label>'
      + '<input type="url" placeholder="https://..." value="' + escHtml(cl.url || '') + '"'
      + ' oninput="updateCustomLink(\'' + cl.id + '\',\'url\',this.value)"></div>'
      + '</div>'
      + '<button class="remove-btn" style="margin-top:6px;" onclick="removeCustomLink(\'' + cl.id + '\')">Remove</button>'
      + '</div>';
  }).join('');
}

function addCustomLink() {
  if (!currentResume) return;
  currentResume.data.personalInfo.customLinks.push({ id: generateId(), platform: '', url: '' });
  var c = document.getElementById('customLinksContainer');
  if (c) c.innerHTML = renderCustomLinksHTML(currentResume.data.personalInfo.customLinks);
  scheduleAutoSave();
}

function updateCustomLink(id, field, value) {
  if (!currentResume) return;
  var link = currentResume.data.personalInfo.customLinks.find(function(l){ return l.id === id; });
  if (link) { link[field] = value; scheduleAutoSave(); renderPreview(); }
}

function removeCustomLink(id) {
  if (!currentResume) return;
  currentResume.data.personalInfo.customLinks = currentResume.data.personalInfo.customLinks
    .filter(function(l){ return l.id !== id; });
  var c = document.getElementById('customLinksContainer');
  if (c) c.innerHTML = renderCustomLinksHTML(currentResume.data.personalInfo.customLinks);
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — SECTION DISPATCHER
   ========================================================= */

function renderFormSection(key) {
  var container = document.getElementById('form-section-' + key);
  if (!container) return;
  var renderers = {
    summary:         renderSummaryForm,
    education:       renderEducationForm,
    skills:          renderSkillsForm,
    projects:        renderProjectsForm,
    workExperience:  renderWorkExperienceForm,
    achievements:    renderAchievementsForm,
    certifications:  renderCertificationsForm,
    languages:       renderLanguagesForm,
    extracurricular: renderExtracurricularForm
  };
  if (renderers[key]) renderers[key](container);
}

/* =========================================================
   FORM RENDERING — PROFESSIONAL SUMMARY
   ========================================================= */

function renderSummaryForm(container) {
  var text = stripHtmlToPlainText(currentResume.data.summary.text || '');
  container.innerHTML = sectionHeader('\uD83D\uDCDD', 'Professional Summary', 'summary')
    + '<div class="fs-body">'
    + '<div class="field-wrap"><label>Summary <span class="fs-hint">(50\u2013300 words recommended)</span></label>'
    + '<textarea rows="5" placeholder="Write a brief professional summary..." '
    + 'data-br-form="summary.text" '
    + 'oninput="updateSummary(this.value)">' + escHtml(text) + '</textarea></div>'
    + '<div class="word-count" id="summaryWordCount">' + countWords(text) + ' words</div>'
    + '</div>';
}

function countWords(text) {
  return text && text.trim() ? text.trim().split(/\s+/).length : 0;
}

function updateSummary(value) {
  if (!currentResume) return;
  currentResume.data.summary.text = value;
  var el = document.getElementById('summaryWordCount');
  if (el) {
    var n = countWords(value);
    el.textContent = n + ' words';
    el.style.color = n > 300 ? '#ef4444' : n >= 50 ? '#22c55e' : '#94a3b8';
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — EDUCATION
   ========================================================= */

function renderEducationForm(container) {
  var items = currentResume.data.education;
  container.innerHTML = sectionHeader('\uD83C\uDF93', 'Education', 'education')
    + '<div class="fs-body">'
    + '<div id="educationEntries">'
    + (items.length ? items.map(renderEducationCardHTML).join('') : '<p class="fs-empty">No education added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addEducationEntry()">+ Add Education</button>'
    + '</div>';
}

function renderEducationCardHTML(e) {
  return '<div class="entry-card" data-id="' + e.id + '">'
    + '<div class="entry-card-header"><strong>' + escHtml(e.degree || 'New Education') + '</strong>'
    + '<button class="remove-btn" onclick="removeEducationEntry(\'' + e.id + '\')">Remove</button></div>'
    + '<div class="field-grid field-grid-2">'
    + entryField('Degree',            e.id, 'degree',      e.degree,      'B.Tech Computer Science', 'updateEduField')
    + entryField('Branch',            e.id, 'branch',      e.branch,      'Computer Science',        'updateEduField')
    + entryField('Institution',       e.id, 'institution', e.institution, 'ABC University',           'updateEduField')
    + entryField('Location',          e.id, 'location',    e.location,    'New Delhi, India',         'updateEduField')
    + monthYearPair('Start', 'startMonth', 'startYear', e.startMonth, e.startYear, e.id, 'updateEduField', false)
    + monthYearPair('End / Expected', 'endMonth', 'endYear', e.endMonth, e.endYear, e.id, 'updateEduField', false)
    + entryField('CGPA / Percentage', e.id, 'cgpa',        e.cgpa,        '8.5 / 10',                 'updateEduField')
    + '</div>'
    + '<div class="field-wrap"><label>Description <span class="fs-hint">(optional)</span></label>'
    + '<textarea rows="2" placeholder="Relevant coursework, honors..." '
    + 'oninput="updateEduField(\'' + e.id + '\',\'description\',this.value)">' + escHtml(e.description || '') + '</textarea></div>'
    + '</div>';
}

function addEducationEntry() {
  if (!currentResume) return;
  currentResume.data.education.push({
    id: generateId(), degree: '', branch: '', institution: '', location: '',
    startMonth: '', startYear: '', endMonth: '', endYear: '', cgpa: '', description: ''
  });
  var c = document.getElementById('form-section-education');
  if (c) renderEducationForm(c);
  scheduleAutoSave();
}

function removeEducationEntry(id) {
  if (!currentResume) return;
  currentResume.data.education = currentResume.data.education.filter(function(e){ return e.id !== id; });
  var c = document.getElementById('form-section-education');
  if (c) renderEducationForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateEduField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.education.find(function(e){ return e.id === id; });
  if (!entry) return;
  entry[field] = value;
  if (field === 'degree') {
    var h = document.querySelector('[data-id="' + id + '"] .entry-card-header strong');
    if (h) h.textContent = value || 'New Education';
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — SKILLS
   ========================================================= */

function renderSkillsForm(container) {
  var cats = currentResume.data.skills;
  container.innerHTML = sectionHeader('\u26A1', 'Skills', 'skills')
    + '<div class="fs-body">'
    + '<p class="fs-hint" style="margin-bottom:10px;">Organize skills by category. Each category is optional.</p>'
    + '<div id="skillCategories">'
    + (cats.length ? cats.map(renderSkillCatHTML).join('') : '<p class="fs-empty">No skill categories yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addSkillCategory()">+ Add Category</button>'
    + '</div>';
}

function renderSkillCatHTML(cat) {
  var tags = cat.items.map(function(item) {
    return '<span class="tag">' + escHtml(item.name)
      + '<button onclick="removeSkillItem(\'' + cat.id + '\',\'' + item.id + '\')">x</button></span>';
  }).join('');

  return '<div class="entry-card skill-cat-card" data-id="' + cat.id + '">'
    + '<div class="entry-card-header">'
    + '<input class="cat-name-input" type="text" placeholder="Category (e.g. Programming Languages)" '
    + 'value="' + escHtml(cat.category || '') + '" oninput="updateSkillCatName(\'' + cat.id + '\',this.value)">'
    + '<button class="remove-btn" onclick="removeSkillCategory(\'' + cat.id + '\')">Remove</button></div>'
    + '<div class="tag-list skill-tag-list" id="skill-tags-' + cat.id + '">' + tags + '</div>'
    + '<div class="inline-input skill-add-row">'
    + '<input type="text" id="skill-input-' + cat.id + '" placeholder="Add skill, press Enter"'
    + ' onkeydown="if(event.key===\'Enter\'){addSkillItem(\'' + cat.id + '\');event.preventDefault();}">'
    + '<button class="add-btn" onclick="addSkillItem(\'' + cat.id + '\')">Add</button>'
    + '</div></div>';
}

function addSkillCategory() {
  if (!currentResume) return;
  currentResume.data.skills.push({ id: generateId(), category: '', items: [] });
  var c = document.getElementById('form-section-skills');
  if (c) renderSkillsForm(c);
  scheduleAutoSave();
}

function removeSkillCategory(catId) {
  if (!currentResume) return;
  currentResume.data.skills = currentResume.data.skills.filter(function(c){ return c.id !== catId; });
  var c = document.getElementById('form-section-skills');
  if (c) renderSkillsForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateSkillCatName(catId, value) {
  if (!currentResume) return;
  var cat = currentResume.data.skills.find(function(c){ return c.id === catId; });
  if (cat) { cat.category = value; scheduleAutoSave(); renderPreview(); }
}

function addSkillItem(catId) {
  if (!currentResume) return;
  var input = document.getElementById('skill-input-' + catId);
  if (!input || !input.value.trim()) return;
  var cat = currentResume.data.skills.find(function(c){ return c.id === catId; });
  if (!cat) return;
  cat.items.push({ id: generateId(), name: input.value.trim() });
  input.value = '';
  var tagsEl = document.getElementById('skill-tags-' + catId);
  if (tagsEl) {
    tagsEl.innerHTML = cat.items.map(function(item) {
      return '<span class="tag">' + escHtml(item.name)
        + '<button onclick="removeSkillItem(\'' + catId + '\',\'' + item.id + '\')">x</button></span>';
    }).join('');
  }
  scheduleAutoSave(); renderPreview();
}

function removeSkillItem(catId, itemId) {
  if (!currentResume) return;
  var cat = currentResume.data.skills.find(function(c){ return c.id === catId; });
  if (!cat) return;
  cat.items = cat.items.filter(function(i){ return i.id !== itemId; });
  var tagsEl = document.getElementById('skill-tags-' + catId);
  if (tagsEl) {
    tagsEl.innerHTML = cat.items.map(function(item) {
      return '<span class="tag">' + escHtml(item.name)
        + '<button onclick="removeSkillItem(\'' + catId + '\',\'' + item.id + '\')">x</button></span>';
    }).join('');
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — PROJECTS
   ========================================================= */

function renderProjectsForm(container) {
  var items = currentResume.data.projects;
  container.innerHTML = sectionHeader('\uD83D\uDE80', 'Projects', 'projects')
    + '<div class="fs-body">'
    + '<div id="projectEntries">'
    + (items.length ? items.map(renderProjectCardHTML).join('') : '<p class="fs-empty">No projects added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addProjectEntry()">+ Add Project</button>'
    + '</div>';
}

function renderProjectCardHTML(p) {
  var bullets = p.bullets || [];
  var bulletHTML = bullets.map(function(b) {
    return '<div class="bullet-item">'
      + '<span class="bullet-dot">\u2022</span>'
      + '<input type="text" class="bullet-input" placeholder="Describe a contribution..." '
      + 'value="' + escHtml(stripHtmlToPlainText(b.text || '')) + '" '
      + 'oninput="updateProjectBullet(\'' + p.id + '\',\'' + b.id + '\',this.value)">'
      + '<button class="bullet-remove" onclick="removeProjectBullet(\'' + p.id + '\',\'' + b.id + '\')" title="Remove">\u00d7</button>'
      + '</div>';
  }).join('');

  return '<div class="entry-card" data-id="' + p.id + '">'
    + '<div class="entry-card-header"><strong>' + escHtml(p.title || 'New Project') + '</strong>'
    + '<button class="remove-btn" onclick="removeProjectEntry(\'' + p.id + '\')">Remove</button></div>'
    + '<div class="field-grid field-grid-2">'
    + entryField('Project Title',     p.id, 'title',        p.title,       'My Awesome Project',     'updateProjectField')
    + entryField('Technologies Used', p.id, 'technologies', p.technologies,'React, Node.js, MongoDB', 'updateProjectField')
    + '<div class="field-wrap"><label>GitHub URL</label>'
    + '<input type="url" placeholder="github.com/user/repo" value="' + escHtml(p.githubUrl || '') + '"'
    + ' oninput="updateProjectField(\'' + p.id + '\',\'githubUrl\',this.value)"'
    + ' onblur="validateUrlField(this)"></div>'
    + '<div class="field-wrap"><label>Live Demo URL</label>'
    + '<input type="url" placeholder="yourproject.com" value="' + escHtml(p.liveUrl || '') + '"'
    + ' oninput="updateProjectField(\'' + p.id + '\',\'liveUrl\',this.value)"'
    + ' onblur="validateUrlField(this)"></div>'
    + monthYearPair('Start', 'startMonth', 'startYear', p.startMonth, p.startYear, p.id, 'updateProjectField', false)
    + monthYearPair('End',   'endMonth',   'endYear',   p.endMonth,   p.endYear,   p.id, 'updateProjectField', p.ongoing)
    + '</div>'
    + '<label class="checkbox-label"><input type="checkbox" ' + (p.ongoing ? 'checked' : '')
    + ' onchange="toggleProjectOngoing(\'' + p.id + '\',this.checked)"> Currently Ongoing</label>'
    + '<div class="field-wrap" style="margin-top:8px;"><label>Project Description</label>'
    + '<textarea rows="2" placeholder="Brief overview of the project..." '
    + 'oninput="updateProjectField(\'' + p.id + '\',\'description\',this.value)">' + escHtml(stripHtmlToPlainText(p.description || '')) + '</textarea></div>'
    + '<div class="field-wrap" style="margin-top:8px;">'
    + '<label>Key Contributions <span class="fs-hint">(bullet points)</span></label>'
    + '<div class="bullet-editor"><div class="bullet-editor-list" id="proj-bullets-' + p.id + '">'
    + bulletHTML
    + '</div>'
    + '<button class="add-btn" onclick="addProjectBullet(\'' + p.id + '\')">+ Add Point</button>'
    + '</div></div>'
    + '</div>';
}

function addProjectEntry() {
  if (!currentResume) return;
  currentResume.data.projects.push({
    id: generateId(), title: '', description: '', technologies: '',
    githubUrl: '', liveUrl: '', startMonth: '', startYear: '',
    endMonth: '', endYear: '', ongoing: false
  });
  var c = document.getElementById('form-section-projects');
  if (c) renderProjectsForm(c);
  scheduleAutoSave();
}

function removeProjectEntry(id) {
  if (!currentResume) return;
  currentResume.data.projects = currentResume.data.projects.filter(function(p){ return p.id !== id; });
  var c = document.getElementById('form-section-projects');
  if (c) renderProjectsForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateProjectField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.projects.find(function(p){ return p.id === id; });
  if (!entry) return;
  entry[field] = value;
  if (field === 'title') {
    var h = document.querySelector('[data-id="' + id + '"] .entry-card-header strong');
    if (h) h.textContent = value || 'New Project';
  }
  scheduleAutoSave(); renderPreview();
}

function toggleProjectOngoing(id, checked) {
  if (!currentResume) return;
  var entry = currentResume.data.projects.find(function(p){ return p.id === id; });
  if (!entry) return;
  entry.ongoing = checked;
  var c = document.getElementById('form-section-projects');
  if (c) renderProjectsForm(c);
  scheduleAutoSave(); renderPreview();
}

function addProjectBullet(projId) {
  if (!currentResume) return;
  var proj = currentResume.data.projects.find(function(p){ return p.id === projId; });
  if (!proj) return;
  if (!proj.bullets) proj.bullets = [];
  var bullet = { id: generateId(), text: '' };
  proj.bullets.push(bullet);

  var list = document.getElementById('proj-bullets-' + projId);
  if (list) {
    var item = document.createElement('div');
    item.className = 'bullet-item';
    item.innerHTML = '<span class="bullet-dot">\u2022</span>'
      + '<input type="text" class="bullet-input" placeholder="Describe a contribution..." '
      + 'oninput="updateProjectBullet(\'' + projId + '\',\'' + bullet.id + '\',this.value)">'
      + '<button class="bullet-remove" onclick="removeProjectBullet(\'' + projId + '\',\'' + bullet.id + '\')">\u00d7</button>';
    list.appendChild(item);
    list.querySelector('input:last-of-type') && list.lastElementChild.querySelector('input').focus();
  }
  scheduleAutoSave();
}

function updateProjectBullet(projId, bulletId, value) {
  if (!currentResume) return;
  var proj = currentResume.data.projects.find(function(p){ return p.id === projId; });
  if (!proj || !proj.bullets) return;
  var b = proj.bullets.find(function(b){ return b.id === bulletId; });
  if (b) { b.text = value; scheduleAutoSave(); renderPreview(); }
}

function removeProjectBullet(projId, bulletId) {
  if (!currentResume) return;
  var proj = currentResume.data.projects.find(function(p){ return p.id === projId; });
  if (!proj || !proj.bullets) return;
  proj.bullets = proj.bullets.filter(function(b){ return b.id !== bulletId; });
  var list = document.getElementById('proj-bullets-' + projId);
  if (list) {
    var items = list.querySelectorAll('.bullet-item');
    items.forEach(function(el) {
      var btn = el.querySelector('.bullet-remove');
      if (btn && btn.getAttribute('onclick') && btn.getAttribute('onclick').indexOf(bulletId) > -1) el.remove();
    });
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — WORK EXPERIENCE
   ========================================================= */

function renderWorkExperienceForm(container) {
  var items = currentResume.data.workExperience;
  container.innerHTML = sectionHeader('\uD83D\uDCBC', 'Work Experience', 'workExperience')
    + '<div class="fs-body">'
    + '<div id="workEntries">'
    + (items.length ? items.map(renderWorkCardHTML).join('') : '<p class="fs-empty">No work experience added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addWorkEntry()">+ Add Experience</button>'
    + '</div>';
}

function renderWorkCardHTML(w) {
  var empTypes = ['Full-time','Part-time','Internship','Contract','Freelance'];
  var typeOpts = '<option value="">Select type</option>' + empTypes.map(function(t){
    return '<option value="' + t + '"' + (w.employmentType === t ? ' selected' : '') + '>' + t + '</option>';
  }).join('');

  var resps = w.responsibilities || [];
  var respHTML = resps.map(function(r) {
    return '<div class="bullet-item">'
      + '<span class="bullet-dot">\u2022</span>'
      + '<input type="text" class="bullet-input" placeholder="Describe a responsibility or achievement..." '
      + 'value="' + escHtml(stripHtmlToPlainText(r.text || '')) + '" '
      + 'oninput="updateWorkResp(\'' + w.id + '\',\'' + r.id + '\',this.value)">'
      + '<button class="bullet-remove" onclick="removeWorkResp(\'' + w.id + '\',\'' + r.id + '\')">\u00d7</button>'
      + '</div>';
  }).join('');

  return '<div class="entry-card" data-id="' + w.id + '">'
    + '<div class="entry-card-header"><strong>' + escHtml(w.role || w.company || 'New Experience') + '</strong>'
    + '<button class="remove-btn" onclick="removeWorkEntry(\'' + w.id + '\')">Remove</button></div>'
    + '<div class="field-grid field-grid-2">'
    + entryField('Company Name', w.id, 'company',  w.company,  'Google Inc.',       'updateWorkField')
    + entryField('Role / Title', w.id, 'role',     w.role,     'Software Engineer', 'updateWorkField')
    + entryField('Location',     w.id, 'location', w.location, 'Bangalore, India',  'updateWorkField')
    + '<div class="field-wrap"><label>Employment Type</label>'
    + '<select onchange="updateWorkField(\'' + w.id + '\',\'employmentType\',this.value)">' + typeOpts + '</select></div>'
    + monthYearPair('Start', 'startMonth', 'startYear', w.startMonth, w.startYear, w.id, 'updateWorkField', false)
    + monthYearPair('End',   'endMonth',   'endYear',   w.endMonth,   w.endYear,   w.id, 'updateWorkField', w.currentlyWorking)
    + '</div>'
    + '<label class="checkbox-label"><input type="checkbox" ' + (w.currentlyWorking ? 'checked' : '')
    + ' onchange="toggleWorkCurrent(\'' + w.id + '\',this.checked)"> Currently Working Here</label>'
    + '<div class="field-wrap" style="margin-top:8px;">'
    + '<label>Responsibilities & Achievements <span class="fs-hint">(bullet points)</span></label>'
    + '<div class="bullet-editor"><div class="bullet-editor-list" id="work-resps-' + w.id + '">'
    + respHTML
    + '</div>'
    + '<button class="add-btn" onclick="addWorkResp(\'' + w.id + '\')">+ Add Point</button>'
    + '</div></div>'
    + '</div>';
}

function addWorkEntry() {
  if (!currentResume) return;
  currentResume.data.workExperience.push({
    id: generateId(), company: '', role: '', location: '', employmentType: '',
    startMonth: '', startYear: '', endMonth: '', endYear: '',
    currentlyWorking: false, description: '', keyAchievements: ''
  });
  var c = document.getElementById('form-section-workExperience');
  if (c) renderWorkExperienceForm(c);
  scheduleAutoSave();
}

function removeWorkEntry(id) {
  if (!currentResume) return;
  currentResume.data.workExperience = currentResume.data.workExperience.filter(function(w){ return w.id !== id; });
  var c = document.getElementById('form-section-workExperience');
  if (c) renderWorkExperienceForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateWorkField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.workExperience.find(function(w){ return w.id === id; });
  if (!entry) return;
  entry[field] = value;
  if (field === 'role' || field === 'company') {
    var h = document.querySelector('[data-id="' + id + '"] .entry-card-header strong');
    if (h) h.textContent = entry.role || entry.company || 'New Experience';
  }
  scheduleAutoSave(); renderPreview();
}

function toggleWorkCurrent(id, checked) {
  if (!currentResume) return;
  var entry = currentResume.data.workExperience.find(function(w){ return w.id === id; });
  if (!entry) return;
  entry.currentlyWorking = checked;
  var c = document.getElementById('form-section-workExperience');
  if (c) renderWorkExperienceForm(c);
  scheduleAutoSave(); renderPreview();
}

function addWorkResp(workId) {
  if (!currentResume) return;
  var entry = currentResume.data.workExperience.find(function(w){ return w.id === workId; });
  if (!entry) return;
  if (!entry.responsibilities) entry.responsibilities = [];
  var resp = { id: generateId(), text: '' };
  entry.responsibilities.push(resp);

  var list = document.getElementById('work-resps-' + workId);
  if (list) {
    var item = document.createElement('div');
    item.className = 'bullet-item';
    item.innerHTML = '<span class="bullet-dot">\u2022</span>'
      + '<input type="text" class="bullet-input" placeholder="Describe a responsibility or achievement..." '
      + 'oninput="updateWorkResp(\'' + workId + '\',\'' + resp.id + '\',this.value)">'
      + '<button class="bullet-remove" onclick="removeWorkResp(\'' + workId + '\',\'' + resp.id + '\')">\u00d7</button>';
    list.appendChild(item);
  }
  scheduleAutoSave();
}

function updateWorkResp(workId, respId, value) {
  if (!currentResume) return;
  var entry = currentResume.data.workExperience.find(function(w){ return w.id === workId; });
  if (!entry || !entry.responsibilities) return;
  var r = entry.responsibilities.find(function(r){ return r.id === respId; });
  if (r) { r.text = value; scheduleAutoSave(); renderPreview(); }
}

function removeWorkResp(workId, respId) {
  if (!currentResume) return;
  var entry = currentResume.data.workExperience.find(function(w){ return w.id === workId; });
  if (!entry || !entry.responsibilities) return;
  entry.responsibilities = entry.responsibilities.filter(function(r){ return r.id !== respId; });
  var list = document.getElementById('work-resps-' + workId);
  if (list) {
    list.querySelectorAll('.bullet-item').forEach(function(el) {
      var btn = el.querySelector('.bullet-remove');
      if (btn && btn.getAttribute('onclick') && btn.getAttribute('onclick').indexOf(respId) > -1) el.remove();
    });
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — ACHIEVEMENTS
   ========================================================= */

function renderAchievementsForm(container) {
  var items = currentResume.data.achievements;
  container.innerHTML = sectionHeader('\uD83C\uDFC6', 'Achievements', 'achievements')
    + '<div class="fs-body">'
    + '<div id="achievementEntries">'
    + (items.length ? items.map(renderAchievementCardHTML).join('') : '<p class="fs-empty">No achievements added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addAchievementEntry()">+ Add Achievement</button>'
    + '</div>';
}

function renderAchievementCardHTML(a) {
  return '<div class="entry-card" data-id="' + a.id + '">'
    + '<div class="entry-card-header"><strong>' + escHtml(a.title || 'New Achievement') + '</strong>'
    + '<button class="remove-btn" onclick="removeAchievementEntry(\'' + a.id + '\')">Remove</button></div>'
    + '<div class="field-grid field-grid-2">'
    + entryField('Achievement Title', a.id, 'title', a.title, 'LeetCode 400+ Problems', 'updateAchField')
    + entryField('Date (optional)',   a.id, 'date',  a.date,  'June 2025',              'updateAchField')
    + entryField('URL (optional)',    a.id, 'url',   a.url,   'https://...',            'updateAchField')
    + '</div>'
    + '<div class="field-wrap"><label>Description <span class="fs-hint">(optional)</span></label>'
    + '<textarea rows="2" placeholder="Describe the achievement..." '
    + 'oninput="updateAchField(\'' + a.id + '\',\'description\',this.value)">' + escHtml(stripHtmlToPlainText(a.description || '')) + '</textarea></div>'
    + '</div>';
}

function addAchievementEntry() {
  if (!currentResume) return;
  currentResume.data.achievements.push({ id: generateId(), title: '', description: '', date: '', url: '' });
  var c = document.getElementById('form-section-achievements');
  if (c) renderAchievementsForm(c);
  scheduleAutoSave();
}

function removeAchievementEntry(id) {
  if (!currentResume) return;
  currentResume.data.achievements = currentResume.data.achievements.filter(function(a){ return a.id !== id; });
  var c = document.getElementById('form-section-achievements');
  if (c) renderAchievementsForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateAchField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.achievements.find(function(a){ return a.id === id; });
  if (!entry) return;
  entry[field] = value;
  if (field === 'title') {
    var h = document.querySelector('[data-id="' + id + '"] .entry-card-header strong');
    if (h) h.textContent = value || 'New Achievement';
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — CERTIFICATIONS
   ========================================================= */

function renderCertificationsForm(container) {
  var items = currentResume.data.certifications;
  container.innerHTML = sectionHeader('\uD83D\uDCDC', 'Certifications', 'certifications')
    + '<div class="fs-body">'
    + '<div id="certEntries">'
    + (items.length ? items.map(renderCertCardHTML).join('') : '<p class="fs-empty">No certifications added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addCertEntry()">+ Add Certification</button>'
    + '</div>';
}

function renderCertCardHTML(c) {
  return '<div class="entry-card" data-id="' + c.id + '">'
    + '<div class="entry-card-header"><strong>' + escHtml(c.name || 'New Certification') + '</strong>'
    + '<button class="remove-btn" onclick="removeCertEntry(\'' + c.id + '\')">Remove</button></div>'
    + '<div class="field-grid field-grid-2">'
    + entryField('Certificate Name',      c.id, 'name',          c.name,          'AWS Solutions Architect', 'updateCertField')
    + entryField('Issuing Organization',  c.id, 'organization',  c.organization,  'Amazon Web Services',    'updateCertField')
    + entryField('Issue Date',            c.id, 'issueDate',     c.issueDate,     'June 2025',              'updateCertField')
    + entryField('Credential URL',        c.id, 'credentialUrl', c.credentialUrl, 'https://...',            'updateCertField')
    + '</div></div>';
}

function addCertEntry() {
  if (!currentResume) return;
  currentResume.data.certifications.push({ id: generateId(), name: '', organization: '', issueDate: '', credentialUrl: '' });
  var c = document.getElementById('form-section-certifications');
  if (c) renderCertificationsForm(c);
  scheduleAutoSave();
}

function removeCertEntry(id) {
  if (!currentResume) return;
  currentResume.data.certifications = currentResume.data.certifications.filter(function(c){ return c.id !== id; });
  var c = document.getElementById('form-section-certifications');
  if (c) renderCertificationsForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateCertField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.certifications.find(function(c){ return c.id === id; });
  if (!entry) return;
  entry[field] = value;
  if (field === 'name') {
    var h = document.querySelector('[data-id="' + id + '"] .entry-card-header strong');
    if (h) h.textContent = value || 'New Certification';
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   FORM RENDERING — LANGUAGES
   ========================================================= */

function renderLanguagesForm(container) {
  var items = currentResume.data.languages;
  container.innerHTML = sectionHeader('\uD83C\uDF10', 'Languages', 'languages')
    + '<div class="fs-body">'
    + '<div id="languageEntries">'
    + (items.length ? items.map(renderLanguageCardHTML).join('') : '<p class="fs-empty">No languages added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addLanguageEntry()">+ Add Language</button>'
    + '</div>';
}

function renderLanguageCardHTML(l) {
  var profs = ['Beginner','Intermediate','Fluent','Native'];
  var opts = '<option value="">Select level</option>' + profs.map(function(p){
    return '<option value="' + p + '"' + (l.proficiency === p ? ' selected' : '') + '>' + p + '</option>';
  }).join('');
  return '<div class="entry-card" data-id="' + l.id + '">'
    + '<div class="field-grid field-grid-2">'
    + entryField('Language', l.id, 'language', l.language, 'English', 'updateLangField')
    + '<div class="field-wrap"><label>Proficiency <span class="fs-hint">(optional)</span></label>'
    + '<select onchange="updateLangField(\'' + l.id + '\',\'proficiency\',this.value)">' + opts + '</select></div>'
    + '</div>'
    + '<button class="remove-btn" style="margin-top:6px;" onclick="removeLanguageEntry(\'' + l.id + '\')">Remove</button>'
    + '</div>';
}

function addLanguageEntry() {
  if (!currentResume) return;
  currentResume.data.languages.push({ id: generateId(), language: '', proficiency: '' });
  var c = document.getElementById('form-section-languages');
  if (c) renderLanguagesForm(c);
  scheduleAutoSave();
}

function removeLanguageEntry(id) {
  if (!currentResume) return;
  currentResume.data.languages = currentResume.data.languages.filter(function(l){ return l.id !== id; });
  var c = document.getElementById('form-section-languages');
  if (c) renderLanguagesForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateLangField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.languages.find(function(l){ return l.id === id; });
  if (entry) { entry[field] = value; scheduleAutoSave(); renderPreview(); }
}

/* =========================================================
   FORM RENDERING — EXTRACURRICULAR
   ========================================================= */

function renderExtracurricularForm(container) {
  var items = currentResume.data.extracurricular;
  container.innerHTML = sectionHeader('\uD83C\uDFAF', 'Extracurricular Activities', 'extracurricular')
    + '<div class="fs-body">'
    + '<div id="extraEntries">'
    + (items.length ? items.map(renderExtraCardHTML).join('') : '<p class="fs-empty">No activities added yet.</p>')
    + '</div>'
    + '<button class="add-btn" onclick="addExtraEntry()">+ Add Activity</button>'
    + '</div>';
}

function renderExtraCardHTML(e) {
  return '<div class="entry-card" data-id="' + e.id + '">'
    + '<div class="entry-card-header"><strong>' + escHtml(e.activity || 'New Activity') + '</strong>'
    + '<button class="remove-btn" onclick="removeExtraEntry(\'' + e.id + '\')">Remove</button></div>'
    + entryField('Activity / Role', e.id, 'activity', e.activity, 'President, CS Club', 'updateExtraField')
    + '<div class="field-wrap"><label>Description <span class="fs-hint">(optional)</span></label>'
    + '<textarea rows="2" placeholder="Describe your role and contributions..." '
    + 'oninput="updateExtraField(\'' + e.id + '\',\'description\',this.value)">' + escHtml(stripHtmlToPlainText(e.description || '')) + '</textarea></div>'
    + '</div>';
}

function addExtraEntry() {
  if (!currentResume) return;
  currentResume.data.extracurricular.push({ id: generateId(), activity: '', description: '' });
  var c = document.getElementById('form-section-extracurricular');
  if (c) renderExtracurricularForm(c);
  scheduleAutoSave();
}

function removeExtraEntry(id) {
  if (!currentResume) return;
  currentResume.data.extracurricular = currentResume.data.extracurricular.filter(function(e){ return e.id !== id; });
  var c = document.getElementById('form-section-extracurricular');
  if (c) renderExtracurricularForm(c);
  scheduleAutoSave(); renderPreview();
}

function updateExtraField(id, field, value) {
  if (!currentResume) return;
  var entry = currentResume.data.extracurricular.find(function(e){ return e.id === id; });
  if (!entry) return;
  entry[field] = value;
  if (field === 'activity') {
    var h = document.querySelector('[data-id="' + id + '"] .entry-card-header strong');
    if (h) h.textContent = value || 'New Activity';
  }
  scheduleAutoSave(); renderPreview();
}

/* =========================================================
   RESUME COMPLETENESS INDICATOR
   ========================================================= */

function calculateCompleteness() {
  if (!currentResume) return { score: 0, tips: [] };
  var d    = currentResume.data;
  var pi   = d.personalInfo;
  var sec  = currentResume.sections;
  var score = 0;
  var tips  = [];

  /* Resume name (5) */
  if (currentResume.resumeName && currentResume.resumeName !== 'Untitled Resume') score += 5;
  else tips.push('Name your resume');

  /* Full name (5) */
  if (pi.fullName && pi.fullName.trim()) score += 5;
  else tips.push('Add your full name');

  /* Contact info: email OR phone (10) */
  if (pi.email || pi.phone) score += 10;
  else tips.push('Add email or phone');

  /* At least one online profile (5) */
  if (pi.linkedin || pi.github || pi.portfolio || pi.leetcode) score += 5;
  else tips.push('Add a LinkedIn or GitHub profile');

  /* Summary (10) */
  if (sec.summary && d.summary.text && d.summary.text.trim()) score += 10;
  else tips.push('Add a professional summary');

  /* Education (15) */
  if (sec.education && d.education.length > 0 && (d.education[0].degree || d.education[0].institution)) score += 15;
  else tips.push('Add your education');

  /* Skills (15) */
  var hasSkills = (d.skills || []).some(function(c){ return c.items && c.items.length > 0; });
  if (sec.skills && hasSkills) score += 15;
  else tips.push('Add your skills');

  /* Projects (15) */
  var hasProjects = (d.projects || []).some(function(p){ return p.title; });
  if (sec.projects && hasProjects) score += 15;
  else tips.push('Add at least one project');

  /* Work experience (10) */
  var hasWork = (d.workExperience || []).some(function(w){ return w.company || w.role; });
  if (sec.workExperience && hasWork) score += 10;

  /* Achievements (5) */
  if (sec.achievements && (d.achievements || []).some(function(a){ return a.title; })) score += 5;

  /* Certifications (5) */
  if (sec.certifications && (d.certifications || []).some(function(c){ return c.name; })) score += 5;

  /* Languages (5) */
  if (sec.languages && (d.languages || []).some(function(l){ return l.language; })) score += 5;

  return { score: Math.min(100, score), tips: tips.slice(0, 3) };
}

function renderCompletenessBar() {
  var bar    = document.getElementById('completenessBar');
  var scoreEl= document.getElementById('completenessScore');
  var fillEl = document.getElementById('completenessFill');
  var tipsEl = document.getElementById('completenessTips');
  if (!bar || !currentResume) { if (bar) bar.style.display = 'none'; return; }

  var result = calculateCompleteness();
  var pct    = result.score;

  bar.style.display = 'block';
  scoreEl.textContent = pct + '%';
  fillEl.style.width  = pct + '%';

  fillEl.className = 'completeness-fill'
    + (pct < 30 ? ' completeness-fill--low'
    : pct < 60  ? ' completeness-fill--mid'
    : pct < 85  ? ' completeness-fill--good'
    : ' completeness-fill--great');

  tipsEl.innerHTML = result.tips.map(function(t) {
    return '<span class="completeness-tip">\u2192 ' + escHtml(t) + '</span>';
  }).join('');
}

/* =========================================================
   FORMAT DRAWER — UI HELPERS
   ========================================================= */

function toggleFmtSection(headerEl) {
  var body = headerEl.nextElementSibling;
  if (!body) return;
  body.classList.toggle('fmt-hidden');
  var ch = headerEl.querySelector('.fmt-chevron');
  if (ch) ch.textContent = body.classList.contains('fmt-hidden') ? '\u25BC' : '\u25B2';
}

function fmtSection(title, rows, expanded) {
  var open = expanded !== false;
  return '<div class="fmt-section">'
    + '<div class="fmt-section-header" onclick="toggleFmtSection(this)">'
    + title
    + '<span class="fmt-chevron">' + (open ? '\u25B2' : '\u25BC') + '</span>'
    + '</div>'
    + '<div class="fmt-section-body' + (open ? '' : ' fmt-hidden') + '">'
    + rows.join('')
    + '</div></div>';
}

function fmtRow(label, controlHTML) {
  return '<div class="fmt-row"><span class="fmt-label">' + label + '</span>'
    + '<div class="fmt-control">' + controlHTML + '</div></div>';
}

function fmtSelect(field, options, current) {
  var opts = options.map(function(o) {
    var label = o.charAt(0).toUpperCase() + o.slice(1);
    return '<option value="' + o + '"' + (o === current ? ' selected' : '') + '>' + label + '</option>';
  }).join('');
  return '<select onchange="updateFormat(\'' + field + '\',this.value)">' + opts + '</select>';
}

function fmtNumber(field, value, min, max) {
  return '<input type="number" min="' + min + '" max="' + max + '" value="' + value + '" '
    + 'oninput="updateFormatNumber(\'' + field + '\',this.value)">';
}

/* NOTE: previously named fmtColor(field,value) — this silently shadowed
   the real selection-formatting fmtColor(command,colorHex) defined
   earlier (function declarations later in the file win), which meant
   every text-color/highlight-color click in the toolbar was actually
   calling THIS html-generator instead of applying color to the
   selection. Renamed to remove the collision. */
function fmtColorInput(field, value) {
  return '<input type="color" value="' + escHtml(value) + '" '
    + 'oninput="updateFormat(\'' + field + '\',this.value)" '
    + 'onchange="updateFormat(\'' + field + '\',this.value)">';
}

function fmtCheckbox(field, checked, label) {
  return '<label class="checkbox-label" style="justify-content:space-between;margin:0;">'
    + '<span style="font-size:11.5px;color:#475569;">' + label + '</span>'
    + '<input type="checkbox" ' + (checked ? 'checked' : '')
    + ' onchange="updateFormat(\'' + field + '\',this.checked)">'
    + '</label>';
}

/* =========================================================
   FORMAT DRAWER — MAIN RENDER
   ========================================================= */

function renderFormatDrawer() {
  var body = document.getElementById('formatDrawerBody');
  if (!body || !currentResume) return;
  var fmt  = currentResume.format || DEFAULT_FORMAT;

  var FONTS = ['Times New Roman', 'Calibri', 'Arial', 'Cambria', 'Garamond', 'Georgia', 'Helvetica'];
  var LINE_SPACINGS = ['0.5', '0.75', '1.0', '1.1', '1.15', '1.2', '1.3', '1.5', '1.75', '2.0'];

  var html = '';

  /* ================================================================
     SELECTION FORMATTING (operates on selected text in the preview)
     ================================================================ */
  html += fmtSection('\uD83D\uDD8D Selection Format  \u2014 select text in preview first', [

    /* B / I / U / S quick buttons */
    '<div class="fmt-bius-row">'
      + '<button class="fmt-bius-btn" id="fmtBoldBtn"   title="Bold"          onmousedown="event.preventDefault()" onclick="fmtCmd(\'bold\')"><b>B</b></button>'
      + '<button class="fmt-bius-btn" id="fmtItalBtn"   title="Italic"        onmousedown="event.preventDefault()" onclick="fmtCmd(\'italic\')"><i>I</i></button>'
      + '<button class="fmt-bius-btn" id="fmtUnderBtn"  title="Underline"     onmousedown="event.preventDefault()" onclick="fmtCmd(\'underline\')"><u>U</u></button>'
      + '<button class="fmt-bius-btn" id="fmtStrikeBtn" title="Strikethrough" onmousedown="event.preventDefault()" onclick="fmtCmd(\'strikeThrough\')"><s>S</s></button>'
      + '<button class="fmt-bius-btn" style="font-size:11px;" title="Clear formatting" onmousedown="event.preventDefault()" onclick="fmtClear()">✕ Clear</button>'
    + '</div>',

    /* Formatting inspector — shows what's applied to the current selection */
    '<div class="fmt-inspector-wrap">'
      + '<span class="fmt-inspector-label">Selected text styles:</span>'
      + '<div class="fmt-inspector" id="fmtInspector"><span class="fmt-inspector-empty">No formatting on current selection</span></div>'
    + '</div>',

    /* Font size for selection */
    fmtRow('Font Size (selection)',
      '<select class="ft-select" style="max-width:80px;color:#1e293b;background:#f9fafb;border-color:#d1d5db;" '
      + 'onmousedown="event.stopPropagation()" onchange="fmtFontSize(this.value)">'
      + '<option value="">-- px --</option>'
      + [8,9,10,11,12,13,14,16,18,20,24,28].map(function(s){
          return '<option value="' + s + '">' + s + 'px</option>';
        }).join('')
      + '</select>'),

    /* Line height for selected block */
    fmtRow('Line Height (block)',
      '<select class="ft-select" style="max-width:90px;color:#1e293b;background:#f9fafb;border-color:#d1d5db;" '
      + 'onmousedown="event.stopPropagation()" onchange="fmtLineHeight(this.value)">'
      + '<option value="">-- --</option>'
      + ['0.5','0.75','1.0','1.15','1.25','1.5','1.75','2.0'].map(function(v){
          return '<option value="' + v + '">' + v + '</option>';
        }).join('')
      + '</select>'),

    /* Letter spacing for selection */
    fmtRow('Letter Spacing',
      '<select class="ft-select" style="max-width:100px;color:#1e293b;background:#f9fafb;border-color:#d1d5db;" '
      + 'onmousedown="event.stopPropagation()" onchange="fmtLetterSpacing(this.value)">'
      + '<option value="">-- --</option>'
      + [['Tight', '-0.5px'], ['Normal', '0px'], ['Wide', '0.5px'], ['Wider', '1px'], ['Widest', '2px']].map(function(p){
          return '<option value="' + p[1] + '">' + p[0] + '</option>';
        }).join('')
      + '</select>'),

    /* Color palette for selection */
    '<div class="fmt-row" style="flex-direction:column;align-items:flex-start;gap:5px;">'
      + '<span class="fmt-label" style="font-weight:600;">Text Color</span>'
      + '<div class="fmt-color-grid">'
      + [
          '#000000','#111111','#374151','#6b7280','#9ca3af','#d1d5db','#f3f4f6','#ffffff',
          '#1e3a8a','#1d4ed8','#2563eb','#3b82f6','#60a5fa','#93c5fd','#bfdbfe','#dbeafe',
          '#166534','#15803d','#16a34a','#22c55e','#4ade80','#86efac','#bbf7d0','#dcfce7',
          '#7c2d12','#9a3412','#c2410c','#ea580c','#fb923c','#fdba74','#fed7aa','#ffedd5',
          '#581c87','#7e22ce','#9333ea','#a855f7','#c084fc','#d8b4fe','#e9d5ff','#f3e8ff',
          '#831843','#be185d','#db2777','#ec4899','#f472b6','#f9a8d4','#fce7f3','#fdf2f8',
          '#713f12','#a16207','#ca8a04','#eab308','#facc15','#fde047','#fef08a','#fef9c3',
          '#0f4c81','#0369a1','#0284c7','#0ea5e9','#38bdf8','#7dd3fc','#bae6fd','#e0f2fe'
        ].map(function(c) {
          return '<div class="fmt-color-swatch" style="background:' + c + ';" '
            + 'title="' + c + '" '
            + 'onmousedown="event.preventDefault()" '
            + 'onclick="fmtColor(\'foreColor\',\'' + c + '\')"></div>';
        }).join('')
      + '</div>'
      + '<div style="display:flex;gap:6px;align-items:center;margin-top:2px;">'
      + '<label style="font-size:11px;color:#64748b;">Custom:</label>'
      + '<input type="color" value="#111111" '
      + 'onmousedown="event.stopPropagation()" '
      + 'oninput="fmtColor(\'foreColor\',this.value)" style="width:36px;height:26px;padding:2px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;">'
      + '</div>'
    + '</div>',

    /* Highlight color palette */
    '<div class="fmt-row" style="flex-direction:column;align-items:flex-start;gap:5px;">'
      + '<span class="fmt-label" style="font-weight:600;">Highlight Color</span>'
      + '<div style="display:flex;gap:4px;flex-wrap:wrap;">'
      + [
          ['#ffff00','Yellow'],['#90EE90','Green'],['#ADD8E6','Blue'],
          ['#FFB6C1','Pink'],['#FFA500','Orange'],['#E6E6FA','Lavender'],
          ['#ffffff','None']
        ].map(function(p) {
          return '<div class="fmt-color-swatch" style="background:' + p[0] + ';border:1px solid #e2e8f0;width:20px;height:20px;" '
            + 'title="' + p[1] + '" '
            + 'onmousedown="event.preventDefault()" '
            + 'onclick="fmtColor(\'hiliteColor\',\'' + p[0] + '\')"></div>';
        }).join('')
      + '</div>'
    + '</div>',

    '<p class="fmt-hint">👆 Select text in the Resume Preview, then apply formatting above.</p>'

  ], true); /* expanded by default */

  /* --- Density Mode --- */
  var densityBtns = ['compact', 'balanced', 'comfortable'].map(function(mode) {
    var icons  = { compact: '\u26A1', balanced: '\u2696', comfortable: '\uD83C\uDF3F' };
    var labels = { compact: 'Compact', balanced: 'Balanced', comfortable: 'Spacious' };
    return '<button class="density-btn' + (fmt.densityMode === mode ? ' active' : '') + '" '
      + 'onclick="applyDensityMode(\'' + mode + '\')">'
      + icons[mode] + ' ' + labels[mode] + '</button>';
  }).join('');

  html += fmtSection('Density Mode', [
    '<div class="density-btns">' + densityBtns + '</div>'
  ], true);

  /* --- Font Family --- */
  var fontOpts = FONTS.map(function(f) {
    return '<option value="' + f + '"' + (fmt.fontFamily === f ? ' selected' : '') + '>' + f + '</option>';
  }).join('');

  html += fmtSection('Font Family', [
    fmtRow('Typeface', '<select style="max-width:150px;" onchange="updateFormat(\'fontFamily\',this.value)">' + fontOpts + '</select>')
  ], true);

  /* --- Font Sizes --- */
  html += fmtSection('Font Sizes (px)', [
    fmtRow('Your Name',       fmtNumber('fontSize.name',       fmt.fontSize.name,       14, 40)),
    fmtRow('Section Headings',fmtNumber('fontSize.heading',    fmt.fontSize.heading,    8,  18)),
    fmtRow('Entry Titles',    fmtNumber('fontSize.subheading', fmt.fontSize.subheading, 8,  18)),
    fmtRow('Body Text',       fmtNumber('fontSize.body',       fmt.fontSize.body,       8,  16))
  ], true);

  /* --- Spacing --- */
  var lsOpts = LINE_SPACINGS.map(function(v) {
    return '<option value="' + v + '"' + (String(fmt.lineSpacing) === v ? ' selected' : '') + '>' + v + '</option>';
  }).join('');

  html += fmtSection('Spacing', [
    fmtRow('Line Spacing',   '<select onchange="updateFormat(\'lineSpacing\',parseFloat(this.value))">' + lsOpts + '</select>'),
    fmtRow('Between Sections', fmtSelect('sectionSpacing', ['compact', 'normal', 'spacious'], fmt.sectionSpacing)),
    fmtRow('Between Bullets',  fmtSelect('bulletSpacing',  ['compact', 'normal', 'spacious'], fmt.bulletSpacing))
  ], false);

  /* --- Page Layout --- */
  html += fmtSection('Page Layout', [
    fmtRow('Page Size', fmtSelect('pageSize',    ['A4', 'Letter', 'Legal'],         fmt.pageSize)),
    fmtRow('Margins',   fmtSelect('pageMargins', ['narrow', 'normal', 'wide'],      fmt.pageMargins))
  ], false);

  /* --- Colors --- */
  html += fmtSection('Colors', [
    fmtRow('Heading Color', fmtColorInput('headingColor', fmt.headingColor)),
    fmtRow('Accent Color',  fmtColorInput('accentColor',  fmt.accentColor)),
    fmtRow('Link Color',    fmtColorInput('linkColor',     fmt.linkColor))
  ], false);

  /* --- Content Formatting --- */
  html += fmtSection('Content Formatting', [
    fmtCheckbox('boldProjectTitle',   fmt.boldProjectTitle,   'Bold project / entry titles'),
    fmtCheckbox('italicCompanyName',  fmt.italicCompanyName,  'Italic company / institution names'),
    fmtCheckbox('underlineLinks',     fmt.underlineLinks,     'Underline hyperlinks'),
    fmtCheckbox('fontStyle.name',     fmt.fontStyle.name,     'Italic your name'),
    fmtCheckbox('fontStyle.heading',  fmt.fontStyle.heading,  'Italic section headings'),
    fmtCheckbox('textDecoration.heading', fmt.textDecoration.heading, 'Underline section headings')
  ], false);

  /* Reset */
  html += '<button class="btn-secondary" style="width:100%;margin-top:10px;font-size:12px;" onclick="resetFormat()">'
    + '\u21BA Reset to Defaults</button>';

  body.innerHTML = html;
}

/* =========================================================
   FORMAT CONTROLS — UPDATE FUNCTIONS
   ========================================================= */

function updateFormat(field, value) {
  if (!currentResume) return;
  if (!currentResume.format) currentResume.format = JSON.parse(JSON.stringify(DEFAULT_FORMAT));

  /* Handle nested paths: 'fontSize.body', 'fontStyle.name', etc. */
  var parts = field.split('.');
  if (parts.length === 2) {
    if (!currentResume.format[parts[0]]) currentResume.format[parts[0]] = {};
    currentResume.format[parts[0]][parts[1]] = value;
  } else {
    currentResume.format[field] = value;
  }

  applyFormatToPreview(currentResume.format);
  scheduleAutoSave();
}

function updateFormatNumber(field, value) {
  var n = parseFloat(value);
  if (!isNaN(n)) updateFormat(field, n);
}

function applyDensityMode(mode) {
  if (!currentResume) return;
  if (!currentResume.format) currentResume.format = JSON.parse(JSON.stringify(DEFAULT_FORMAT));

  var preset = DENSITY_PRESETS[mode];
  if (!preset) return;

  var fmt = currentResume.format;
  fmt.densityMode    = mode;
  fmt.lineSpacing    = preset.lineSpacing;
  fmt.sectionSpacing = preset.sectionSpacing;
  fmt.bulletSpacing  = preset.bulletSpacing;
  fmt.pageMargins    = preset.pageMargins;

  var ps = preset.fontSize;
  var fs = fmt.fontSize;
  Object.keys(ps).forEach(function(k){ fs[k] = ps[k]; });

  applyFormatToPreview(fmt);
  renderFormatDrawer();       /* Re-render drawer controls to reflect new values */
  scheduleAutoSave();
  showToast('Density: ' + mode.charAt(0).toUpperCase() + mode.slice(1));
}

function optimizeForOnePage() {
  if (!currentResume) return;
  if (!currentResume.format) currentResume.format = JSON.parse(JSON.stringify(DEFAULT_FORMAT));

  var fmt = currentResume.format;

  /* Incrementally compress — never goes below minimum values */
  fmt.lineSpacing    = Math.max(1.0,  (parseFloat(fmt.lineSpacing) || 1.15) - 0.1);
  fmt.sectionSpacing = fmt.sectionSpacing === 'spacious' ? 'normal' : 'compact';
  fmt.bulletSpacing  = fmt.bulletSpacing  === 'spacious' ? 'normal' : 'compact';
  fmt.pageMargins    = fmt.pageMargins    === 'wide'     ? 'normal' : 'narrow';
  fmt.densityMode    = 'compact';

  var fs = fmt.fontSize;
  fs.body       = Math.max(9,  (fs.body       || 11) - 1);
  fs.heading    = Math.max(9,  (fs.heading    || 11) - 1);
  fs.subheading = Math.max(10, (fs.subheading || 12) - 1);

  applyFormatToPreview(fmt);
  renderFormatDrawer();
  scheduleAutoSave();
  showToast('\u26A1 Layout compressed — check preview');
  setTimeout(updatePageIndicator, 250);  /* re-check page count after reflow */
}

function resetFormat() {
  if (!currentResume) return;
  currentResume.format = JSON.parse(JSON.stringify(DEFAULT_FORMAT));
  applyFormatToPreview(currentResume.format);
  renderFormatDrawer();
  scheduleAutoSave();
  showToast('Format reset to defaults.');
}

/* =========================================================
   FORMAT DRAWER — OPEN / CLOSE
   ========================================================= */

function openFormatDrawer() {
  if (!currentResume) { showToast('Open a resume first.', 'error'); return; }
  renderFormatDrawer();
  document.getElementById('formatDrawer').classList.add('open');
  document.getElementById('formatOverlay').classList.add('open');
}

function closeFormatDrawer() {
  document.getElementById('formatDrawer').classList.remove('open');
  document.getElementById('formatOverlay').classList.remove('open');
}

/* =========================================================
   AUTOSAVE
   ========================================================= */

var autoSaveTimer = null;

function scheduleAutoSave() {
  showSaveStatus('saving');
  debouncePushHistory();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveCurrentResume, 1400);
}

function showSaveStatus(status) {
  var el = document.getElementById('saveStatus');
  if (!el) return;
  if (status === 'saving') {
    el.textContent = 'Saving...';
    el.className = 'save-status save-status--saving';
  } else if (status === 'error') {
    el.textContent = 'Save failed \u2013 retrying on next edit';
    el.className = 'save-status save-status--error';
  } else {
    el.textContent = 'Saved \u2713';
    el.className = 'save-status save-status--saved';
  }
}

function updateBuilderToolbar() {
  var nameEl = document.getElementById('resumeNameText');
  if (nameEl && currentResume) nameEl.textContent = currentResume.resumeName || 'Untitled Resume';
  var lastEl = document.getElementById('lastSaved');
  if (lastEl && currentResume) {
    var d = new Date(currentResume.lastModifiedDate);
    lastEl.textContent = 'Saved at ' + d.toLocaleTimeString();
  }
}

/* =========================================================
   PAGE INDICATOR & PAGE BREAK VISUALIZATION
   ========================================================= */

/* A4 dimensions: 210mm × 297mm.
   We calculate height dynamically based on the preview width
   so it stays accurate as the user resizes the panel.     */
function getA4PageHeightPx() {
  var paper = document.getElementById('resumePreview');
  if (!paper) return 1056;
  var w = paper.clientWidth;
  return w > 0 ? Math.round(w * (297 / 210)) : 1056;
}

function updatePageIndicator() {
  var paper  = document.getElementById('resumePreview');
  var bar    = document.getElementById('pageIndicatorBar');
  var label  = document.getElementById('pageIndicatorText');
  if (!paper || !bar || !label) return;

  if (!currentResume) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';

  /* Wait one frame so scrollHeight reflects the just-rendered content */
  requestAnimationFrame(function() {
    var pageH      = getA4PageHeightPx();
    var totalH     = paper.scrollHeight;
    var pageCount  = Math.max(1, Math.ceil(totalH / pageH));
    var fraction   = (totalH / pageH).toFixed(2);

    /* Update label text and color */
    var color, content;
    if (pageCount === 1 && parseFloat(fraction) <= 1.0) {
      color   = '#16a34a';
      content = '\uD83D\uDCC4 1 Page \u2014 Perfect length \u2713';
    } else if (pageCount === 1 && parseFloat(fraction) > 0.85) {
      color   = '#d97706';
      content = '\uD83D\uDCC4 ' + Math.round(parseFloat(fraction) * 100) + '% of one page';
    } else {
      color   = '#dc2626';
      content = '\uD83D\uDCC4 ' + pageCount + ' pages'
        + ' &nbsp;<button class="one-page-btn" onclick="optimizeForOnePage()">\u26A1 Optimize for 1 Page</button>';
    }

    label.innerHTML = '<span style="color:' + color + ';font-weight:600;">' + content + '</span>';

    /* Remove stale page-break markers */
    paper.querySelectorAll('.page-break-marker').forEach(function(m) { m.remove(); });

    /* Inject dashed lines at each page boundary */
    if (pageCount > 1) {
      for (var i = 1; i < pageCount; i++) {
        var marker = document.createElement('div');
        marker.className = 'page-break-marker';
        marker.style.top = (i * pageH) + 'px';
        var lbl = document.createElement('span');
        lbl.className = 'page-break-label';
        lbl.textContent = 'Page ' + (i + 1);
        marker.appendChild(lbl);
        paper.appendChild(marker);
      }
    }
  });
}

/* =========================================================
   BUILDER INITIALIZATION
   ========================================================= */

/* Build a lookup map once so reordering doesn't require rebuilding SECTION_DEFS */
var _sectionDefMap = null;
function getSectionDefMap() {
  if (!_sectionDefMap) {
    _sectionDefMap = {};
    SECTION_DEFS.forEach(function(d){ _sectionDefMap[d.key] = d; });
  }
  return _sectionDefMap;
}

function renderBuilderForm() {
  if (!currentResume) return;

  updateBuilderToolbar();
  renderCompletenessBar();

  var root = document.getElementById('formSections');
  if (!root) return;

  var defMap = getSectionDefMap();
  var order  = currentResume.sectionOrder || SECTION_DEFS.map(function(d){ return d.key; });

  var html = '<div class="form-section" id="form-section-personalInfo"></div>';
  order.forEach(function(key) {
    if (!defMap[key]) return;
    html += '<div class="form-section' + (currentResume.sections[key] ? '' : ' form-section--hidden') + '" '
          + 'id="form-section-' + key + '"></div>';
  });
  root.innerHTML = html;

  renderPersonalInfoForm();
  order.forEach(function(key) {
    if (currentResume.sections[key]) renderFormSection(key);
  });
}

async function initBuilder() {
  var id = getCurrentResumeId();
  if (id) {
    var loaded = await loadResumeById(id);
    if (!loaded) { currentResume = null; openNewResumeModal(); return; }
  } else {
    currentResume = null;
    openNewResumeModal();
    return;
  }

  saveSelectedTemplate(currentResume.selectedTemplate);
  applyFormatToPreview(currentResume.format || DEFAULT_FORMAT);
  renderBuilderForm();
  initTemplateSwitcher();

  /* Preview is always reconstructed from data + formatting metadata,
     never from a saved raw-HTML snapshot — this is what guarantees
     formatting survives reload/template-switch/section-reorder
     correctly instead of drifting out of sync with the form data. */
  renderPreview();

  /* Seed the history stack for this session */
  _history = [];
  _histIdx  = -1;
  pushHistory();
  updateUndoRedoBtns();
}

/* =========================================================
   NEW RESUME MODAL
   ========================================================= */

var _resumeModalMode = 'create'; // 'create' | 'rename'

function initiateNewResume() {
  currentResume = null;
  clearCurrentResumeId();
  navigateTo('builder');
}

function openNewResumeModal() {
  _resumeModalMode = 'create';
  var modal = document.getElementById('newResumeModal');
  var title = document.getElementById('newResumeModalTitle');
  var btn   = document.getElementById('confirmResumeBtn');
  var input = document.getElementById('newResumeNameInput');
  if (!modal) return;
  if (title) title.textContent = 'Name Your Resume';
  if (btn)   btn.textContent   = 'Create Resume';
  if (input) { input.value = ''; input.style.borderColor = ''; }
  modal.classList.add('open');
  if (input) setTimeout(function(){ input.focus(); }, 150);
}

function openRenameModal() {
  if (!currentResume) return;
  _resumeModalMode = 'rename';
  var modal = document.getElementById('newResumeModal');
  var title = document.getElementById('newResumeModalTitle');
  var btn   = document.getElementById('confirmResumeBtn');
  var input = document.getElementById('newResumeNameInput');
  if (!modal) return;
  if (title) title.textContent = 'Rename Resume';
  if (btn)   btn.textContent   = 'Save Name';
  if (input) { input.value = currentResume.resumeName; input.style.borderColor = ''; }
  modal.classList.add('open');
  if (input) setTimeout(function(){ input.focus(); input.select(); }, 150);
}

function editResumeName() { openRenameModal(); }

function closeNewResumeModal() {
  var modal = document.getElementById('newResumeModal');
  if (modal) modal.classList.remove('open');
  if (_resumeModalMode === 'create' && !currentResume) navigateTo('home');
}

async function confirmResumeNameAction() {
  var input = document.getElementById('newResumeNameInput');
  var name  = input ? input.value.trim() : '';
  if (!name) {
    if (input) { input.style.borderColor = '#ef4444'; input.focus(); }
    return;
  }
  if (input) input.style.borderColor = '';

  if (_resumeModalMode === 'rename' && currentResume) {
    currentResume.resumeName = name;
    closeNewResumeModal();
    updateBuilderToolbar();
    scheduleAutoSave();
    return;
  }

  /* Lazy-creation: clicking "Create Resume" only opens the builder
     in-memory (resumeId stays null). No backend row exists yet --
     the first real edit's scheduleAutoSave() call is what triggers
     saveCurrentResume() to POST and mint the server UUID. This is
     what avoids abandoned-session junk rows for people who name a
     resume and then navigate away without ever touching the form. */
  currentResume = createEmptyResume(name);
  clearCurrentResumeId();
  closeNewResumeModal();
  renderBuilderForm();
  initTemplateSwitcher();
  renderPreview();
  updateBuilderToolbar();
}

/* =========================================================
   PDF EXPORT SYSTEM
   Uses the browser's own native print pipeline instead of
   rasterizing the preview. Why: an image-based export
   (html2canvas + manually-overlaid link boxes) can never
   contain selectable text, and any tiny pixel-math error in
   the overlay makes clicks land on the wrong link — which is
   exactly what happened. Printing the real, live HTML/CSS
   means the browser lays out the actual <a> tags itself, so
   links always land in the right place and text stays
   selectable in the resulting PDF (via the browser's own
   "Save as PDF" destination in the print dialog).
   ========================================================= */

/* ---- Export dropdown menu open/close ---- */
function toggleExportMenu(e) {
  if (e) e.stopPropagation();
  var menu = document.getElementById('exportMenu');
  if (!menu) return;
  menu.style.display = (menu.style.display === 'none' || !menu.style.display) ? 'block' : 'none';
}

document.addEventListener('click', function (e) {
  var wrap = document.getElementById('exportMenuWrap');
  var menu = document.getElementById('exportMenu');
  if (!wrap || !menu) return;
  if (!wrap.contains(e.target)) menu.style.display = 'none';
});

/* ---- Build a safe, meaningful filename from the resume name ---- */
function getExportFileBaseName() {
  var raw = (currentResume && currentResume.resumeName) ? currentResume.resumeName : 'Resume';
  var safe = raw.replace(/[\\/:*?"<>|]/g, '').trim();
  return safe || 'Resume';
}

/* ---- Toggle a small loading state on the export button ---- */
function setExportButtonLoading(isLoading, label) {
  var btn = document.getElementById('exportMenuBtn');
  if (!btn) return;
  if (isLoading) {
    btn.dataset.originalLabel = btn.dataset.originalLabel || btn.innerHTML;
    btn.innerHTML = '⏳ ' + (label || 'Working...');
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalLabel || '📄 Download PDF ▾';
    btn.disabled = false;
  }
}

/* ---- Remove transient UI artifacts (page-break markers, active
   selection/focus) before we snapshot the preview's HTML ---- */
function prepPreviewForCapture(preview) {
  var removed = [];
  preview.querySelectorAll('.page-break-marker').forEach(function (m) {
    removed.push({ el: m, parent: m.parentNode, next: m.nextSibling });
    m.remove();
  });
  if (document.activeElement && preview.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  if (typeof hideFloatingToolbar === 'function') hideFloatingToolbar();
  var sel = window.getSelection && window.getSelection();
  if (sel) sel.removeAllRanges();
  return removed;
}

function restorePreviewAfterCapture(removed) {
  removed.forEach(function (r) {
    if (r.parent) r.parent.insertBefore(r.el, r.next);
  });
}

/* ---- Core: open a clean, print-ready window containing only the
   resume, wired up with the real stylesheet + live formatting CSS,
   so the browser's print/"Save as PDF" pipeline renders the exact
   same look — but as real vector text with real, correctly
   positioned links, not a raster image. ---- */
function openResumePrintWindow(mode) {
  var menu = document.getElementById('exportMenu');
  if (menu) menu.style.display = 'none';

  if (!currentResume) {
    showToast('No resume selected to ' + (mode === 'print' ? 'print' : 'export') + '.', 'error');
    return;
  }
  var preview = document.getElementById('resumePreview');
  if (!preview) {
    showToast('Resume preview not found.', 'error');
    return;
  }

  setExportButtonLoading(true, mode === 'print' ? 'Preparing print...' : 'Generating PDF...');

  var removedMarkers = prepPreviewForCapture(preview);
  var formatStyleEl  = document.getElementById('resumeFormatStyle');
  var formatCSS      = formatStyleEl ? formatStyleEl.textContent : '';
  var templateClass  = Array.prototype.slice.call(preview.classList)
    .filter(function (c) { return c !== 'resume-paper'; }).join(' ');
  var previewHTML    = preview.outerHTML;
  restorePreviewAfterCapture(removedMarkers);
  if (typeof updatePageIndicator === 'function') updatePageIndicator();

  var printWin = window.open('', '_blank', 'width=900,height=1100');
  if (!printWin) {
    setExportButtonLoading(false);
    showToast('Please allow pop-ups to ' + (mode === 'print' ? 'print' : 'export') + ' your resume.', 'error');
    return;
  }

  var fileName = getExportFileBaseName();

  var bannerHTML =
    '<div id="printGuideBanner" style="position:sticky;top:0;z-index:999;background:#eff6ff;' +
    'border-bottom:2px solid #2563eb;padding:14px 20px;font-family:Segoe UI,Arial,sans-serif;">' +
      '<div style="font-weight:700;color:#1e3a8a;font-size:15px;margin-bottom:4px;">' +
        '⚠️ Important: pick the right destination' +
      '</div>' +
      '<div style="color:#1e3a8a;font-size:13.5px;line-height:1.5;">' +
        'In the dialog, set <b>Destination</b> (or <b>Printer</b>) to <b>"Save as PDF"</b> ' +
        '(the browser\'s own option — usually first/pinned in the list).<br>' +
        '<b>Do NOT choose "Microsoft Print to PDF"</b> — that Windows driver flattens the page into an ' +
        'image, so text won\'t be selectable and links won\'t be clickable.' +
      '</div>' +
      '<button onclick="window.__triggerResumePrint()" style="margin-top:10px;background:#2563eb;color:#fff;' +
      'border:none;border-radius:6px;padding:9px 18px;font-size:13.5px;font-weight:600;cursor:pointer;">' +
        'Continue to Print / Save Dialog' +
      '</button>' +
    '</div>';

  printWin.document.write(
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<title>' + escHtml(fileName) + '</title>' +
    '<link rel="stylesheet" href="style.css">' +
    '<style>' + formatCSS + '</style>' +
    '<style>' +
      '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important;}' +
      'html,body{margin:0;padding:0;background:#fff;}' +
      '.print-page-wrap{padding:24px;display:flex;justify-content:center;}' +
      '.resume-paper{box-shadow:none!important;border:none!important;width:210mm;max-width:210mm;margin:0 auto;box-sizing:border-box;}' +
      '.resume-paper a{color:inherit;text-decoration:underline;}' +
      '@page{size:A4;margin:12mm;}' +
      '@media print{ #printGuideBanner{display:none!important;} .print-page-wrap{padding:0;} }' +
    '</style>' +
    '</head><body>' + bannerHTML + '<div class="print-page-wrap">' + previewHTML + '</div></body></html>'
  );
  printWin.document.close();
  printWin.__triggerResumePrint = function () { printWin.print(); };

  printWin.onload = function () {
    setExportButtonLoading(false);
    showToast('Read the on-screen note, then click Continue in the new window.', 'info');
    printWin.focus();
  };
}

/* ---- Public: Download PDF (via native Save-as-PDF print destination) ---- */
function downloadPDF() {
  openResumePrintWindow('download');
}

/* ---- Public: Print Resume ---- */
function printResume() {
  openResumePrintWindow('print');
}

/* ---- Placeholder: DOCX export (future implementation) ---- */
function exportDocxPlaceholder() {
  var menu = document.getElementById('exportMenu');
  if (menu) menu.style.display = 'none';
  showToast('DOCX export coming soon!', 'info');
}

/* =========================================================
   AI ASSISTANT PANEL (placeholder — unchanged)
   ========================================================= */

function sendAIMessage() {
  var input = document.getElementById("aiInput");
  var message = input.value.trim();
  if (message === "") return;
  var chat = document.getElementById("aiChat");
  var userMsg = document.createElement("div");
  userMsg.className = "ai-message user";
  userMsg.textContent = message;
  chat.appendChild(userMsg);
  var aiMsg = document.createElement("div");
  aiMsg.className = "ai-message";
  aiMsg.textContent = "\uD83E\uDD16 AI integration coming soon! This is just a UI preview.";
  chat.appendChild(aiMsg);
  input.value = "";
  chat.scrollTop = chat.scrollHeight;
}

/* ---------- Draggable Panel Resizing (LeetCode-style) ---------- */
const PANEL_MIN_WIDTH = { form: 250, preview: 400, ai: 250 };
const DIVIDER_WIDTH = 6;     // matches .divider { width: 6px }
const DIVIDER_MARGIN = 8;    // 4px margin on each side × 2 = 8px per divider
const TOTAL_DIVIDER_SPACE = (DIVIDER_WIDTH + DIVIDER_MARGIN) * 2; // both dividers combined = 28px

let activeDivider = null;
let startX = 0;
let startTargetWidth = 0;

function pxWidth(el) {
  return el.getBoundingClientRect().width;
}

// direction: +1 = dragging right GROWS targetEl (used for the left divider + form panel)
//            -1 = dragging right SHRINKS targetEl (used for the right divider + ai panel)
function startDrag(divider, targetEl, direction) {
  return function (e) {
    if (divider.classList.contains("disabled")) return;

    activeDivider = { divider: divider, targetEl: targetEl, direction: direction };
    startX = e.clientX;
    startTargetWidth = pxWidth(targetEl);

    divider.classList.add("dragging");
    document.body.classList.add("resizing");

    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", stopDrag);
  };
}

function getContainerWidth() {
  const container = document.getElementById("appLayout");
  const style = window.getComputedStyle(container);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  // clientWidth includes padding — subtract it to get true usable content width
  return container.clientWidth - paddingLeft - paddingRight;
}

function onDrag(e) {
  if (!activeDivider) return;

  const dx = e.clientX - startX;
  const name = activeDivider.targetEl.dataset.panel;
  const minWidth = PANEL_MIN_WIDTH[name] || 150;

  let newWidth = startTargetWidth + activeDivider.direction * dx;

  // 1. Never below this panel's own minimum
  if (newWidth < minWidth) {
    newWidth = minWidth;
  }

  // 2. Never let the OTHER fixed panel + preview's minimum get squeezed
  //    past their own floor. We compute how much space is actually
  //    available inside the container right now and clamp to it.
  const containerWidth = getContainerWidth();
  const otherName = name === "form" ? "ai" : "form";
  const otherPanel = panels[otherName];
  const otherWidth = otherPanel.classList.contains("collapsed")
    ? 44 // matches .panel.collapsed width in CSS
    : pxWidth(otherPanel);

  const totalDividerSpace = TOTAL_DIVIDER_SPACE; // both dividers + margins
  const reservedForPreview = PANEL_MIN_WIDTH.preview;

  const maxAllowedForThisPanel =
    containerWidth - otherWidth - reservedForPreview - totalDividerSpace;

  if (newWidth > maxAllowedForThisPanel) {
    newWidth = Math.max(maxAllowedForThisPanel, minWidth);
  }

  activeDivider.targetEl.style.width = newWidth + "px";
}

function stopDrag() {
  if (activeDivider) {
    activeDivider.divider.classList.remove("dragging");
  }
  document.body.classList.remove("resizing");
  activeDivider = null;

  document.removeEventListener("mousemove", onDrag);
  document.removeEventListener("mouseup", stopDrag);
}

function initPanelResizing() {
  const formPanel = document.querySelector(".form-panel");
  const aiPanel = document.querySelector(".ai-panel");
  const dividerLeft = document.getElementById("dividerLeft");
  const dividerRight = document.getElementById("dividerRight");

  dividerLeft.addEventListener("mousedown", startDrag(dividerLeft, formPanel, 1));
  dividerRight.addEventListener("mousedown", startDrag(dividerRight, aiPanel, -1));
}

/* Re-clamp panel widths if the window/container shrinks
   (e.g. user resizes browser window after manually dragging panels wide) */
function clampPanelsToContainer() {
  const containerWidth = getContainerWidth();
  if (containerWidth <= 0) return;

  const totalDividerSpace = TOTAL_DIVIDER_SPACE;

  ["form", "ai"].forEach(function (name) {
    const el = panels[name];
    if (panelState[name].mode !== "normal") return;

    const currentWidth = pxWidth(el);
    const otherName = name === "form" ? "ai" : "form";
    const otherEl = panels[otherName];
    const otherWidth = otherEl.classList.contains("collapsed") ? 44 : pxWidth(otherEl);

    const maxAllowed =
      containerWidth - otherWidth - PANEL_MIN_WIDTH.preview - totalDividerSpace;

    if (currentWidth > maxAllowed && maxAllowed >= PANEL_MIN_WIDTH[name]) {
      el.style.width = maxAllowed + "px";
    } else if (maxAllowed < PANEL_MIN_WIDTH[name]) {
      el.style.width = PANEL_MIN_WIDTH[name] + "px";
    }
  });
}

window.addEventListener("resize", clampPanelsToContainer);

/* =========================================================
   PREVIEW MUTATION OBSERVER
   Captures every direct in-preview edit, syncs plain text back
   to the data model (shifting formatting metadata to follow the
   edit) + the mirrored form inputs, then schedules autosave.
   ========================================================= */

var _previewMutObs   = null;
var _suspendMutObs   = false; /* raised during programmatic renders */
var _mutDebounceTimer = null;

function initPreviewMutationObserver() {
  var preview = document.getElementById('resumePreview');
  if (!preview) return;

  if (_previewMutObs) _previewMutObs.disconnect();

  _previewMutObs = new MutationObserver(function () {
    if (_suspendMutObs || _histPaused) return;
    clearTimeout(_mutDebounceTimer);
    _mutDebounceTimer = setTimeout(onPreviewMutated, 600);
  });

  _previewMutObs.observe(preview, {
    childList:     true,
    subtree:       true,
    characterData: true,
    attributes:    true,
    attributeFilter: ['style', 'class']
  });
}

function onPreviewMutated() {
  var preview = document.getElementById('resumePreview');
  if (!preview || !currentResume || _suspendMutObs) return;

  /* Sync text of tagged elements back to data + form (plain text only,
     with formatting metadata shifted to follow the edit) */
  syncPreviewToData(preview);

  /* Push to history and schedule save */
  debouncePushHistory();
  scheduleAutoSave();
}

/* Sync elements carrying data-br-field back to the data model.
   Templates stamp these on key text nodes (name, summary, project/
   experience/achievement/extracurricular descriptions, bullets, etc).
   Every field -- rich-eligible or not -- always stores PLAIN TEXT in
   currentResume.data; that's what keeps the Resume Form's textareas
   showing plain text only, never markup. For fields marked
   data-br-rich="1", formatting metadata (currentResume.formatting) is
   shifted to follow whatever the person just typed, so bolding "35%"
   and then typing a word earlier in the same sentence doesn't move
   the bold onto the wrong characters. Paths containing "[id]" address
   an item inside an array (e.g. "projects[abc123].bullets[def456].text")
   via resolveRichPath/setRichFieldValue; plain dotted paths still go
   through the original setNestedPath. */
function syncPreviewToData(preview) {
  if (!preview || !currentResume) return;

  preview.querySelectorAll('[data-br-field]').forEach(function (el) {
    var path = el.getAttribute('data-br-field');
    if (!path) return;
    var isRich  = el.getAttribute('data-br-rich') === '1';
    var newText = stripHtmlToPlainText(el.innerText || el.textContent || '');
    if (!isRich) newText = newText.trim();

    var oldText = isRich
      ? (path.indexOf('[') !== -1 ? getRichFieldValue(path) : (getNestedPath(currentResume.data, path) || ''))
      : null;

    if (path.indexOf('[') !== -1) {
      setRichFieldValue(path, newText);
    } else {
      setNestedPath(currentResume.data, path, newText);
    }

    if (isRich && oldText !== null && oldText !== newText) {
      setFieldSegments(path, shiftSegmentsForTextEdit(getFieldSegments(path), oldText, newText));
    }

    /* Update the corresponding form input in-place (no full re-render).
       Always plain text -- the form must never show HTML tags. */
    var formEl = document.querySelector('[data-br-form="' + path + '"]');
    if (formEl && (formEl.tagName === 'TEXTAREA' || formEl.tagName === 'INPUT')) {
      if (formEl.value !== newText) formEl.value = newText;
    }
  });
}

/* Adjust stored formatting segments to follow a direct text edit typed
   into the preview. Finds the common prefix/suffix between the old and
   new text (i.e. the small changed region in the middle), then shifts
   every segment boundary outside that region by the resulting length
   delta, and clamps boundaries inside it to the edit's edges. This is
   a lightweight diff -- good enough for normal typing/deleting -- not
   a full operational-transform, but it keeps formatting elsewhere in
   the field stable while the person edits nearby text. */
function shiftSegmentsForTextEdit(segments, oldText, newText) {
  if (!segments.length || oldText === newText) return segments;

  var maxCommon = Math.min(oldText.length, newText.length);
  var prefix = 0;
  while (prefix < maxCommon && oldText[prefix] === newText[prefix]) prefix++;

  var suffix = 0;
  while (suffix < (maxCommon - prefix) &&
         oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;

  var oldChangedEnd = oldText.length - suffix;
  var newChangedEnd = newText.length - suffix;
  var delta = newChangedEnd - oldChangedEnd;

  return segments.map(function (s) {
    var start = s.start, end = s.end;
    if (start >= oldChangedEnd) start += delta; else if (start > prefix) start = prefix;
    if (end   >= oldChangedEnd) end   += delta; else if (end   > prefix) end   = prefix;
    return { start: start, end: end, bold: s.bold, italic: s.italic, underline: s.underline,
             strike: s.strike, color: s.color, background: s.background,
             fontSize: s.fontSize, letterSpacing: s.letterSpacing };
  }).filter(function (s) { return s.end > s.start; });
}



function setNestedPath(obj, path, value) {
  var parts = path.split('.');
  var cur   = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur == null) return;
    cur = cur[parts[i]];
  }
  if (cur != null) cur[parts[parts.length - 1]] = value;
}

function getNestedPath(obj, path) {
  var parts = path.split('.');
  var cur   = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/* ---------- Panel Collapse / Full Screen (VS Code / Figma style) ---------- */
const panels = {
  form: document.querySelector(".form-panel"),
  preview: document.querySelector(".preview-panel"),
  ai: document.querySelector(".ai-panel")
};

// Single source of truth: each panel has exactly ONE mode at a time.
const panelState = {
  form: { mode: "normal", lastWidth: null },
  preview: { mode: "normal", lastWidth: null }, // preview can never collapse or be excluded
  ai: { mode: "normal", lastWidth: null }
};

let preFullscreenModes = null; // snapshot of other panels' modes, used to restore on exit

function collapsePanel(name) {
  if (name === "preview") return; // BUSINESS RULE: preview must always stay visible
  const el = panels[name];
  const state = panelState[name];

  if (state.mode === "collapsed") return;

  // RULE: a panel cannot be FULLSCREEN and COLLAPSED at once.
  // Collapsing always exits fullscreen first if needed.
  if (state.mode === "fullscreen") {
    exitFullscreen();
  }

  state.lastWidth = el.style.width || pxWidth(el) + "px";
  el.classList.add("collapsed");
  state.mode = "collapsed";
  updateDividerState();
  updateControlStates();
}

function expandPanel(name) {
  const el = panels[name];
  const state = panelState[name];

  if (state.mode !== "collapsed") return;

  el.classList.remove("collapsed");
  state.mode = "normal";

  // BUG 1 FIX: don't just restore the old width blindly —
  // recalc available space first, so expanding never overflows the container.
  const restoredWidth = state.lastWidth || "280px";
  el.style.width = restoredWidth;

  rebalanceAfterExpand(name);
  updateDividerState();
  updateControlStates();
}

function togglePanelCollapse(name) {
  if (panelState[name].mode === "fullscreen") return; // RULE: ignore collapse clicks while fullscreen
  if (panelState[name].mode === "collapsed") {
    expandPanel(name);
  } else {
    collapsePanel(name);
  }
}

/* BUG 1 FIX: after expanding, verify the three visible panels + dividers
   actually fit inside the container. If not, shrink the expanded panel
   (and if still not enough, shrink the other fixed panel too) down to
   their minimums before anything is allowed to overflow. */
function rebalanceAfterExpand(expandedName) {
  const containerWidth = getContainerWidth();
  const totalDividerSpace = TOTAL_DIVIDER_SPACE;

  const formW = panels.form.classList.contains("collapsed") ? 44 : pxWidth(panels.form);
  const aiW = panels.ai.classList.contains("collapsed") ? 44 : pxWidth(panels.ai);
  const previewMin = PANEL_MIN_WIDTH.preview;

  let overflow = (formW + aiW + previewMin + totalDividerSpace) - containerWidth;
  if (overflow <= 0) return; // fits fine, nothing to do

  // Shrink the panel that was just expanded first, down to its minimum.
  const expandedEl = panels[expandedName];
  const expandedMin = PANEL_MIN_WIDTH[expandedName];
  let expandedCurrent = pxWidth(expandedEl);

  const shrinkable = expandedCurrent - expandedMin;
  const firstShrink = Math.min(shrinkable, overflow);
  if (firstShrink > 0) {
    expandedEl.style.width = (expandedCurrent - firstShrink) + "px";
    overflow -= firstShrink;
  }

  // If still overflowing, shrink the OTHER fixed panel too (down to its minimum).
  if (overflow > 0) {
    const otherName = expandedName === "form" ? "ai" : "form";
    const otherEl = panels[otherName];
    if (!otherEl.classList.contains("collapsed")) {
      const otherMin = PANEL_MIN_WIDTH[otherName];
      const otherCurrent = pxWidth(otherEl);
      const otherShrinkable = otherCurrent - otherMin;
      const secondShrink = Math.min(otherShrinkable, overflow);
      if (secondShrink > 0) {
        otherEl.style.width = (otherCurrent - secondShrink) + "px";
        overflow -= secondShrink;
      }
    }
  }
  // Preview's min-width + container's overflow:hidden act as the final hard floor.
}

function updateDividerState() {
  const formInactive = panelState.form.mode !== "normal";
  const aiInactive = panelState.ai.mode !== "normal";
  document.getElementById("dividerLeft").classList.toggle("disabled", formInactive);
  document.getElementById("dividerRight").classList.toggle("disabled", aiInactive);
}

/* ---- Full Screen: generic, works for ANY panel (form, preview, or ai) ---- */
function getFullscreenPanelName() {
  return Object.keys(panelState).find(function (key) {
    return panelState[key].mode === "fullscreen";
  }) || null;
}

function toggleFullscreen(name) {
  if (panelState[name].mode === "collapsed") return; // RULE: collapsed panels can't go fullscreen directly

  const current = getFullscreenPanelName();
  if (current === name) {
    exitFullscreen();
    return;
  }
  if (current) {
    exitFullscreen(); // RULE: only one panel may be fullscreen at a time
  }
  enterFullscreen(name);
}

function enterFullscreen(name) {
  // Snapshot the OTHER panels' current modes so we can restore them exactly.
  preFullscreenModes = {};
  Object.keys(panels).forEach(function (key) {
    if (key === name) return;
    preFullscreenModes[key] = panelState[key].mode;
    if (panelState[key].mode !== "collapsed") {
      collapsePanel(key); // no-ops automatically for "preview" by design
    }
  });

  panels[name].classList.add("fullscreen");
  panelState[name].mode = "fullscreen";
  updateDividerState();
  updateControlStates();
}

function exitFullscreen() {
  const name = getFullscreenPanelName();
  if (!name) return;

  panels[name].classList.remove("fullscreen");
  panelState[name].mode = "normal";

  Object.keys(preFullscreenModes || {}).forEach(function (key) {
    if (preFullscreenModes[key] === "collapsed") {
      // already collapsed, nothing to do
    } else {
      expandPanel(key);
    }
  });

  preFullscreenModes = null;
  updateDividerState();
  updateControlStates();
}

/* Single function that enforces ALL "only valid state combinations" rules
   across every panel's buttons. Called after every state transition. */
function updateControlStates() {
  Object.keys(panels).forEach(function (name) {
    const panelEl = panels[name];
    const mode = panelState[name].mode;
    const collapseBtn = panelEl.querySelector(".collapse-btn");
    const fullscreenBtn = panelEl.querySelector(".fullscreen-btn");

    if (fullscreenBtn) {
      fullscreenBtn.classList.toggle("active", mode === "fullscreen");
      // RULE: while ANY panel is fullscreen, disable fullscreen-btn on collapsed siblings
      // (they're hidden as tabs anyway, but this keeps state airtight if ever shown)
      fullscreenBtn.disabled = mode === "collapsed";
    }

    if (collapseBtn) {
      // RULE: disable collapse control while this panel is fullscreen.
      collapseBtn.disabled = mode === "fullscreen";
    }
  });
}

function initPanelControls() {
  document.querySelectorAll(".panel").forEach(function (panelEl) {
    const name = panelEl.dataset.panel;

    const collapseBtn = panelEl.querySelector(".collapse-btn");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        togglePanelCollapse(name);
      });
    }

    const fullscreenBtn = panelEl.querySelector(".fullscreen-btn");
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleFullscreen(name);
      });
    }

    // Clicking the collapsed tab itself restores the panel
    const header = panelEl.querySelector(".panel-header");
    header.addEventListener("click", function () {
      if (panelState[name] && panelState[name].mode === "collapsed") {
        expandPanel(name);
      }
    });
  });
}

/* ---------- Builder Template Switcher ---------- */
function initTemplateSwitcher() {
  var switcher = document.getElementById("builderTemplateSwitcher");
  if (!switcher) return;

  // Populate <select> from registry — new templates appear automatically
  switcher.innerHTML = "";
  Object.keys(TemplateRegistry).forEach(function (id) {
    var opt = document.createElement("option");
    opt.value = id;
    opt.textContent = TemplateRegistry[id].name;
    switcher.appendChild(opt);
  });

  // Restore persisted selection
  switcher.value = getSelectedTemplate();

  switcher.addEventListener("change", function () {
    saveSelectedTemplate(this.value);
    renderPreview();
  });
}

/* ---------- Init ---------- */
/* =========================================================
   AUTH PAGES: Login / Register / OTP Verify
   ========================================================= */

/* Remembers which flow the OTP page is currently completing, set
   right before navigating to it from either the login or register
   form. There's only ever one such flow in progress at a time. */
let otpContext = { purpose: null, email: null };

function configureOtpPage(purpose, email) {
  otpContext = { purpose: purpose, email: email };
  var heading = document.getElementById("otpHeading");
  var subheading = document.getElementById("otpSubheading");
  if (purpose === "signup") {
    heading.textContent = "Verify Your Email";
    subheading.textContent = "Enter the 6-digit code we sent to " + email + " to complete registration.";
  } else {
    heading.textContent = "Verify Login";
    subheading.textContent = "Enter the 6-digit code we sent to " + email + " to finish logging in.";
  }
  document.getElementById("otpCodeInput").value = "";
}

function setButtonBusy(button, busyLabel) {
  button.dataset.originalLabel = button.dataset.originalLabel || button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
}

function clearButtonBusy(button) {
  button.disabled = false;
  button.textContent = button.dataset.originalLabel || button.textContent;
}

function initAuthPages() {
  // ---- Login ----
  document.getElementById("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = document.getElementById("loginEmail").value.trim();
    var password = document.getElementById("loginPassword").value;

    if (!email || !password) {
      showToast("Please enter your email and password.", "error");
      return;
    }

    var btn = document.getElementById("loginSubmitBtn");
    setButtonBusy(btn, "Logging in...");
    try {
      var resp = await loginUser(email, password);
      configureOtpPage("login", email);
      navigateTo("otp-verify");
      showToast(resp.message || "OTP sent to your email.", "info");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      clearButtonBusy(btn);
    }
  });

  document.getElementById("goToRegisterLink").addEventListener("click", function (e) {
    e.preventDefault();
    navigateTo("register");
  });

  // ---- Register ----
  document.getElementById("registerForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = document.getElementById("registerEmail").value.trim();
    var username = document.getElementById("registerUsername").value.trim();
    var password = document.getElementById("registerPassword").value;

    if (!email || !username || !password) {
      showToast("Please fill in every field.", "error");
      return;
    }
    if (username.length < 3) {
      showToast("Username must be at least 3 characters.", "error");
      return;
    }
    if (password.length < 8) {
      showToast("Password must be at least 8 characters.", "error");
      return;
    }

    var btn = document.getElementById("registerSubmitBtn");
    setButtonBusy(btn, "Creating account...");
    try {
      var resp = await registerUser(email, username, password);
      configureOtpPage("signup", email);
      navigateTo("otp-verify");
      showToast(resp.message || "OTP sent to your email.", "info");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      clearButtonBusy(btn);
    }
  });

  document.getElementById("goToLoginLink").addEventListener("click", function (e) {
    e.preventDefault();
    navigateTo("login");
  });

  // ---- OTP Verify (shared by both signup and login) ----
  document.getElementById("otpForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var code = document.getElementById("otpCodeInput").value.trim();

    if (!/^\d{6}$/.test(code)) {
      showToast("Enter the 6-digit code.", "error");
      return;
    }
    if (!otpContext.email || !otpContext.purpose) {
      showToast("Something went wrong -- please start again.", "error");
      navigateTo("login");
      return;
    }

    var btn = document.getElementById("otpSubmitBtn");
    setButtonBusy(btn, "Verifying...");
    try {
      if (otpContext.purpose === "signup") {
        await verifyRegisterOtp(otpContext.email, code);
        showToast("Account created successfully. Please log in.", "success");
        document.getElementById("loginEmail").value = otpContext.email;
        otpContext = { purpose: null, email: null };
        navigateTo("login");
      } else {
        await verifyLoginOtp(otpContext.email, code);
        showToast("Welcome back!", "success");
        var destination = pendingRedirectPage || "home";
        pendingRedirectPage = null;
        otpContext = { purpose: null, email: null };
        navigateTo(destination);
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      clearButtonBusy(btn);
    }
  });

  document.getElementById("otpBackLink").addEventListener("click", function (e) {
    e.preventDefault();
    navigateTo(otpContext.purpose === "signup" ? "register" : "login");
  });
}

async function init() {
  initNavbar();          // mounts brand, wires nav links, hamburger (no longer auto-navigates)
  initAuthPages();       // wires login/register/otp-verify forms
  initPanelResizing();
  initPanelControls();
  clampPanelsToContainer();
  updateControlStates();

  // Resolve whether there's a usable session BEFORE deciding the
  // first page to show -- this is what lets a returning user with an
  // expired-but-refreshable access token land on Home instead of
  // being incorrectly bounced to Login.
  var loggedIn = await ensureValidSession();
  navigateTo(loggedIn ? "home" : "login");
}

document.addEventListener("DOMContentLoaded", init);