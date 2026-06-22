require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── STATIC FILES ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// Serve index.html at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── RATE LIMITS ───────────────────────────────────────────────────────────────
const detectLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const shareLimit  = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// ── STORAGE HELPERS ───────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
function loadShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); } catch { return {}; }
}
function saveShares(map) {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(map), 'utf8');
}

function appendLog(file, obj) {
  fs.appendFileSync(path.join(DATA_DIR, file), JSON.stringify(obj) + '\n');
}

// ── CORS (allow viewframe.co.uk and localhost) ─────────────────────────────
app.use((req, res, next) => {
  const allowed = ['https://viewframe.co.uk', 'https://www.viewframe.co.uk'];
  const origin = req.headers.origin || '';
  if (allowed.includes(origin) || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── POST /api/detect ──────────────────────────────────────────────────────────
// Accepts: { imageBase64: string, mediaType: string }
// Streams back NDJSON lines:
//   { type, x_pct, y_pct, w_pct, h_pct, confidence }  (one per detection)
//   { type: 'analysis', summary: string }               (trailing summary)
app.post('/api/detect', detectLimit, async (req, res) => {
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: 'imageBase64 and mediaType are required.' });
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) {
    return res.status(400).json({ error: 'Unsupported image type.' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const SYSTEM = `You are a window and door detection specialist. Analyse the image and identify every window and door visible.

For each one, output a JSON object on its own line (NDJSON format):
{"type":"<type>","x_pct":<number>,"y_pct":<number>,"w_pct":<number>,"h_pct":<number>,"confidence":<0-1>}

Rules:
- x_pct, y_pct = top-left corner as % of image width/height (0–100)
- w_pct, h_pct = width/height as % of image width/height (min 3)
- type must be one of: window-casement, window-sash, window-double, window-bay, window-skylight, window-tilt, door-single, door-double, door-bifold, door-sliding, door-french, door-patio
- confidence: 0.9 = very clear, 0.6 = partially visible, 0.3 = uncertain
- Output ONLY detection JSON lines during scanning, then a single trailing line:
  {"type":"analysis","summary":"<brief 1-2 sentence summary of the scene>"}
- No markdown, no explanations, no extra text.`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imageBase64 }
        }, {
          type: 'text',
          text: 'Detect all windows and doors in this image. Output one JSON object per line.'
        }]
      }]
    });

    let buffer = '';
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        buffer += chunk.delta.text;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) res.write(line + '\n');
        }
      }
    }
    if (buffer.trim()) res.write(buffer.trim() + '\n');

    appendLog('detections.jsonl', { ts: new Date().toISOString(), ok: true });
    res.end();
  } catch (err) {
    console.error('Detect error:', err.message);
    appendLog('detections.jsonl', { ts: new Date().toISOString(), ok: false, err: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Detection failed. Please try again.' });
    } else {
      res.end();
    }
  }
});

// ── POST /api/share ───────────────────────────────────────────────────────────
// Accepts: { elements: [], view: 'inside'|'outside' }
// Returns: { id: string }
app.post('/api/share', shareLimit, (req, res) => {
  const { elements, view } = req.body || {};
  if (!Array.isArray(elements) || !elements.length) {
    return res.status(400).json({ error: 'elements array is required and must not be empty.' });
  }
  if (elements.length > 60) {
    return res.status(400).json({ error: 'Too many elements (max 60).' });
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const shares = loadShares();
  shares[id] = { elements, view: view || 'inside', ts: new Date().toISOString() };
  saveShares(shares);

  appendLog('shares.jsonl', { ts: new Date().toISOString(), id });
  res.json({ id });
});

// ── GET /api/share?id=xxx ─────────────────────────────────────────────────────
app.get('/api/share', shareLimit, (req, res) => {
  const { id } = req.query;
  if (!id || !/^[a-f0-9]{12}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid share id.' });
  }
  const shares = loadShares();
  const layout = shares[id];
  if (!layout) return res.status(404).json({ error: 'Layout not found.' });
  res.json(layout);
});

// ── POST /api/transform ───────────────────────────────────────────────────────
// Accepts: { image, mimeType, style, frameColour }
// Returns: { url } — a Replicate CDN URL for the transformed image
const transformLimit = rateLimit({ windowMs: 60_000, max: 3, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many transformations — please wait a minute.' }
});

app.post('/api/transform', transformLimit, async (req, res) => {
  const { image, mimeType, style, frameColour } = req.body || {};
  if (!image || !mimeType) return res.status(400).json({ error: 'Missing image.' });

  const replicateKey = process.env.REPLICATE_API_TOKEN;
  if (!replicateKey) return res.status(500).json({ error: 'Replicate API token not set.' });

  const colourNames = {
    '#FFFFFF': 'bright white', '#F5F0E8': 'warm cream / ivory', '#C8A97A': 'light oak wood grain',
    '#4A4A4A': 'anthracite grey (RAL 7016)', '#8B6853': 'dark chocolate brown (RAL 8017)',
    '#2C3E50': 'dark navy blue', '#1A1A1A': 'jet black', '#7A9E7E': 'sage green',
    '#D4742A': 'terracotta orange', '#5C5C5C': 'slate grey'
  };
  const styleNames = {
    'window-casement': 'casement', 'window-sash': 'sash', 'window-double': 'double casement',
    'window-bay': 'bay', 'window-skylight': 'skylight', 'window-tilt': 'tilt and turn',
    'door-single': 'single', 'door-double': 'double', 'door-bifold': 'bifold',
    'door-sliding': 'sliding patio', 'door-french': 'french', 'door-patio': 'patio'
  };

  const colourName = colourNames[frameColour] || 'anthracite grey (RAL 7016)';
  const styleName  = styleNames[style] || 'casement';
  const prompt = `Replace all windows and doors on this house with modern ${styleName} windows and doors with ${colourName} coloured frames. The window and door frames must be ${colourName}. Keep the house walls, roof, garden and all surroundings exactly the same — only change the window and door frames. Photorealistic, high quality, architectural photography.`;

  try {
    const predRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${replicateKey}`, 'Content-Type': 'application/json', 'Prefer': 'wait=60' },
      body: JSON.stringify({ input: { prompt, input_image: `data:${mimeType};base64,${image}`, output_format: 'jpg', safety_tolerance: 5 } })
    });
    if (!predRes.ok) {
      const err = await predRes.json().catch(() => ({}));
      return res.status(502).json({ error: `Transformation failed (${predRes.status}).` });
    }
    const pred = await predRes.json();
    if (pred.status === 'succeeded' && pred.output) {
      const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      return res.json({ url });
    }
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
        headers: { 'Authorization': `Bearer ${replicateKey}` }
      });
      const d = await poll.json();
      if (d.status === 'succeeded') {
        const url = Array.isArray(d.output) ? d.output[0] : d.output;
        return res.json({ url });
      }
      if (d.status === 'failed') return res.status(502).json({ error: 'Transformation failed — try again.' });
    }
    return res.status(504).json({ error: 'Transformation timed out — try again.' });
  } catch (err) {
    console.error('Transform error:', err.message);
    return res.status(502).json({ error: "Couldn't reach transformation service." });
  }
});

// ── POST /api/waitlist ────────────────────────────────────────────────────────
app.post('/api/waitlist', (req, res) => {
  const { email, role } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  appendLog('waitlist.jsonl', { ts: new Date().toISOString(), email, role: (role || '').slice(0, 100) });
  res.json({ ok: true });
});

// ── START ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Viewframe running on http://localhost:${PORT}`));
