// Direct printing: label -> 1-bit bitmap -> ESC/POS raster -> QZ Tray -> printer.
// No browser print window, and the page size is whatever the bitmap is: widthDots x widthDots
// (576 x 576 dots = 72 x 72 mm at 203 dpi), then a fixed feed so each label uses exactly 80 mm of paper.
// Needs the free QZ Tray app running on the computer that has the printer (see README).
// Uses layoutLabel / expandLabels / qrRuns / measureFn from labels.js, so it matches the PDF.

const dpErr = (code, message) => Object.assign(new Error(message), { code });

/* ---------- 1. one label -> bits (1 = black), rows of widthDots/8 bytes ---------- */
function renderLabelBits(prims) {
  const cfg = LABEL_CFG.printer, W = cfg.widthDots, scale = W / GRID;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = W;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = '#000';
  const t = Math.max(2, Math.round((0.3 * cfg.dpi) / 25.4));      // line thickness in dots (0.3 mm, like the PDF)
  const edge = (v) => Math.round(Math.min(Math.max(v * scale - t / 2, 0), W - t));
  for (const p of prims) {
    if (p.k === 'rect') {
      ctx.fillRect(0, 0, W, t); ctx.fillRect(0, W - t, W, t); ctx.fillRect(0, 0, t, W); ctx.fillRect(W - t, 0, t, W);
    } else if (p.k === 'line') {
      if (p.x1 === p.x2) { const y1 = Math.round(p.y1 * scale), y2 = Math.round(p.y2 * scale); ctx.fillRect(edge(p.x1), y1, t, y2 - y1 + t / 2); }
      else { const x1 = Math.round(p.x1 * scale), x2 = Math.round(p.x2 * scale); ctx.fillRect(x1, edge(p.y1), x2 - x1 + t / 2, t); }
    } else if (p.k === 'text') {
      ctx.font = `${p.b ? 'bold ' : ''}${(p.px * scale).toFixed(2)}px Helvetica, Arial, "Liberation Sans", sans-serif`;
      ctx.textAlign = p.a === 'middle' ? 'center' : 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(p.s, p.x * scale, p.y * scale);
    } else if (p.k === 'qr') {
      // whole dots per QR module (no blurry edges), centred in the space the layout gives the code
      const { n, runs } = qrRuns(p.text);
      const box = Math.round(p.size * scale), mod = Math.max(1, Math.floor(box / n));
      const ox = Math.round(p.x * scale) + Math.floor((box - mod * n) / 2);
      const oy = Math.round(p.y * scale) + Math.floor((box - mod * n) / 2);
      for (const [r, c, len] of runs) ctx.fillRect(ox + c * mod, oy + r * mod, len * mod, mod);
    }
  }
  const px = ctx.getImageData(0, 0, W, W).data, rowBytes = W / 8;
  const bits = new Uint8Array(rowBytes * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 < 140) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bits;
}

/* ---------- 2. bits -> ESC/POS bytes ---------- */
function escposLabel(bits) {
  const cfg = LABEL_CFG.printer, W = cfg.widthDots, rowBytes = W / 8, BAND = 255;
  const out = [];
  for (let y = 0; y < W; y += BAND) {                       // GS v 0: raster bit image, in bands of up to 255 rows
    const h = Math.min(BAND, W - y);
    out.push(Uint8Array.of(0x1D, 0x76, 0x30, 0x00, rowBytes & 255, rowBytes >> 8, h & 255, h >> 8));
    out.push(bits.subarray(y * rowBytes, (y + h) * rowBytes));
  }
  const feed = Math.min(255, Math.round((cfg.feedMm * cfg.dpi) / 25.4));
  if (feed) out.push(Uint8Array.of(0x1B, 0x4A, feed));       // ESC J n: feed n dots
  if (cfg.cut) out.push(Uint8Array.of(0x1D, 0x56, 0x42, 0x00)); // GS V 66 0: feed to cutter and partial cut
  return out;
}

function toBase64(parts) {
  let len = 0; parts.forEach((p) => (len += p.length));
  const all = new Uint8Array(len); let o = 0;
  parts.forEach((p) => { all.set(p, o); o += p.length; });
  let s = '';
  for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
  return btoa(s);
}

// Everything the printer receives for one batch of labels.
function buildEscposJob(labels, measure) {
  const parts = [Uint8Array.of(0x1B, 0x40)];                 // ESC @: reset the printer
  labels.forEach((L) => escposLabel(renderLabelBits(layoutLabel(L, measure))).forEach((p) => parts.push(p)));
  return parts;
}

/* ---------- 3. QZ Tray connection ---------- */
let _secured = null;
function setupSigning() {            // optional: a signed connection removes QZ's "Allow?" question
  if (_secured) return _secured;
  _secured = fetch('/qz-cert.txt', { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((cert) => {
      if (!/BEGIN CERTIFICATE/.test(cert)) return;
      qz.security.setCertificatePromise((resolve) => resolve(cert));
      qz.security.setSignatureAlgorithm('SHA512');
      qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
        fetch('/api/qz/sign', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: toSign }),
        }).then((r) => (r.ok ? r.text().then(resolve) : reject(new Error('Signing failed')))).catch(reject);
      });
    })
    .catch(() => {});
  return _secured;
}

let _connecting = null;
async function qzConnect() {
  if (typeof qz === 'undefined') throw dpErr('NO_QZ', 'The printing helper script did not load.');
  if (qz.websocket.isActive()) return;
  if (!_connecting) {
    _connecting = setupSigning()
      .then(() => qz.websocket.connect({ retries: 1, delay: 1 }))
      .finally(() => { _connecting = null; });
  }
  try { await _connecting; } catch (e) { throw dpErr('NO_QZ', 'QZ Tray is not running on this computer.'); }
}

// Returns the printer name to use. Asks once (and when force = true) and remembers the choice in this browser.
async function choosePrinter(force) {
  await qzConnect();
  const found = await qz.printers.find();
  const names = Array.isArray(found) ? found : (found ? [found] : []);
  if (!names.length) throw dpErr('NO_PRINTER', 'No printers are installed on this computer.');
  const saved = store.get('printer', '');
  if (!force && saved && names.includes(saved)) return saved;
  let def = ''; try { def = await qz.printers.getDefault(); } catch (e) { /* none set */ }
  const guess = names.includes(saved) ? saved : (names.find((n) => /pos[-\s_]?80/i.test(n)) || (names.includes(def) ? def : names[0]));
  const name = await dialog({
    title: 'Choose the label printer', ok: 'Use this printer',
    html: `<p>Pick the POS-80 printer. Labels will go straight to it, with no print window. This computer will remember your choice.</p>
      <div class="field-row"><div><label class="field" for="d-printer">Printer</label>
      <select id="d-printer">${names.map((n) => `<option value="${esc(n)}" ${n === guess ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div></div>`,
    collect: (d) => d.querySelector('#d-printer').value,
  });
  if (!name) throw dpErr('CANCELLED', 'Cancelled');
  store.set('printer', name);
  return name;
}

// Sends the labels (response of POST /api/labels) straight to the printer. onProgress(done, total) is optional.
async function printDirect(data, printer, onProgress) {
  const labels = expandLabels(data), per = LABEL_CFG.printer.perJob;
  await qzConnect();
  const config = qz.configs.create(printer, { jobName: `Labels ${data.supplier.code}` });
  const measure = measureFn();
  for (let i = 0; i < labels.length; i += per) {             // build one batch, send it, then the next
    const job = buildEscposJob(labels.slice(i, i + per), measure);
    await qz.print(config, [{ type: 'raw', format: 'command', flavor: 'base64', data: toBase64(job) }]);
    if (onProgress) onProgress(Math.min(labels.length, i + per), labels.length);
  }
  return labels.length;
}
