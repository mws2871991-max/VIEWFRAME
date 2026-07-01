const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const fs = require('fs');
const { Resend } = require('resend');

const NOTIFY = process.env.NOTIFY_EMAIL || 'mws2871991@gmail.com';

async function sendNotification(subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log('No RESEND_API_KEY — skipping email:', subject); return; }
  try {
    const resend = new Resend(key);
    await resend.emails.send({ from: 'Viewframe <hello@viewframe.co.uk>', to: NOTIFY, subject, html });
  } catch(e) { console.error('Email error:', e.message); }
}

async function sendEmailTo(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log('No RESEND_API_KEY — skipping user email:', subject); return; }
  try {
    const resend = new Resend(key);
    await resend.emails.send({
      from: 'Viewframe <hello@viewframe.co.uk>',
      to,
      subject,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#0F172A">${html}</div>`
    });
  } catch(e) { console.error('User email error:', e.message); }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20mb' }));

// ── STATIC FILES ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Serve index.html at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Legal pages (extensionless URLs)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/cookies', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookies.html')));

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
// Accepts: { imageBase64, mediaType }  — frontend field names
// Returns NDJSON: one detection object per line, trailing analysis line
app.post('/api/detect', detectLimit, async (req, res) => {
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64 || !mediaType) return res.status(400).json({ error: 'Missing imageBase64 or mediaType.' });
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(mediaType)) return res.status(400).json({ error: 'Unsupported image type.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured.' });

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: `You are a UK window and door surveyor. Detect every window and door visible on the exterior. Return ONLY a JSON array — no markdown, no explanation, nothing else.\n\nClassify each opening using ONLY these types. Read every description before deciding:\n\nWINDOWS:\n- window-sash: Two panels that slide UP and DOWN past each other. Key feature: a horizontal meeting rail (bar) across the middle of the window where the two sashes meet. Taller than wide. Common on Victorian, Edwardian and Georgian terraces and semis. Do NOT call this a casement.\n- window-casement: One or two panels hinged on the SIDE that swing outward like a door. No horizontal bar across the middle. The most common modern window type.\n- window-flush: Modern frame sits completely flat/flush with the sash — no projecting frame lip. Very clean, minimal lines. Common on new builds and contemporary refurbs.\n- window-double: Two casement panes side by side in a single outer frame, usually with a central vertical bar (mullion) dividing them.\n- window-bay: The window PROJECTS OUT from the wall forming a bay. Has three sections — a centre panel facing forward and two angled side panels. The window alcove is visible.\n- window-tilt: Large single-pane tilt-and-turn window. Usually square or near-square, very large pane, minimal frame. Common in modern flats and commercial buildings.\n- window-skylight: Set INTO the roof slope or flat roof — overhead glazing, not on a vertical wall.\n\nDOORS:\n- door-single: One standard door panel, usually solid with possible small glazed panel. The typical front door.\n- door-double: Two equal door panels side by side that both open. Grander entrance doors.\n- door-bifold: Multiple narrow panels (3 or more) that fold back like an accordion. Usually floor-to-ceiling glazed. Common on rear extensions.\n- door-sliding: Two or more panels that slide horizontally past each other on a track. Does not fold.\n- door-french: Two outward-opening glazed door panels. Often leads to a garden or balcony. Glass fills most of each panel.\n- door-patio: Large sliding glazed door, usually one fixed panel and one sliding panel. Common on 1970s–90s homes.\n\nRULES:\n1. If the window has a horizontal bar across its middle and slides up/down → window-sash. Never call it casement.\n2. If the window frame is completely flat with no visible projecting lip → window-flush, not casement.\n3. If the opening projects outward from the wall → window-bay.\n4. Only use window-skylight for roof-mounted glazing.\n5. Detect EVERY visible window and door, including partially visible ones.\n6. x_pct and y_pct are the centre of the opening as a percentage of image width/height.\n\nEach item: {"type":"<type>","confidence":0.0-1.0,"x_pct":0-100,"y_pct":0-100,"w_pct":1-100,"h_pct":1-100}. Add one final item: {"type":"analysis","summary":"2-3 sentences describing the property style, window types found, and approximate age/period"}.` }
        ]}]
      })
    });
  } catch (err) {
    console.error('Detect fetch error:', err.message);
    return res.status(502).json({ error: "Couldn't reach detection service." });
  }

  if (!anthropicRes.ok) {
    let detail = '';
    try { detail = (await anthropicRes.json())?.error?.message || ''; } catch {}
    console.error(`Anthropic ${anthropicRes.status}: ${detail}`);
    return res.status(502).json({ error: `Detection failed (${anthropicRes.status}).` });
  }

  let data;
  try { data = await anthropicRes.json(); } catch {
    return res.status(502).json({ error: 'Unreadable response from detection service.' });
  }

  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const arrMatch = raw.replace(/```json|```/g, '').trim().match(/\[[\s\S]*\]/);
  if (!arrMatch) return res.status(502).json({ error: 'No detections returned — try another photo.' });

  let items;
  try { items = JSON.parse(arrMatch[0]); } catch {
    return res.status(502).json({ error: 'Could not parse detections.' });
  }

  // Write each detection as an NDJSON line so the frontend streaming logic works
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  for (const item of items) {
    res.write(JSON.stringify(item) + '\n');
  }
  appendLog('detections.jsonl', { ts: new Date().toISOString(), count: items.filter(i => i.type !== 'analysis').length });
  res.end();
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
    'window-bay': 'bay', 'window-flush': 'flush', 'window-tilt': 'tilt and turn',
    'door-single': 'single', 'door-double': 'double', 'door-bifold': 'bifold',
    'door-sliding': 'sliding patio', 'door-french': 'french', 'door-patio': 'patio'
  };

  const colourName = colourNames[frameColour] || 'anthracite grey (RAL 7016)';
  const styleName  = styleNames[style] || 'casement';
  const prompt = `Change all window and door frames on this house to ${colourName}. Every single window frame and door frame must be ${colourName} coloured. Replace the existing frames with modern ${styleName} style frames in ${colourName}. Do not change anything else — keep the brickwork, walls, roof, garden, driveway and surroundings exactly as they are. Only the window and door frames change colour to ${colourName}. Photorealistic, high quality, architectural photography.`;

  try {
    const predRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${replicateKey}`, 'Content-Type': 'application/json', 'Prefer': 'wait=60' },
      body: JSON.stringify({ input: { prompt, input_image: `data:${mimeType};base64,${image}`, output_format: 'jpg', safety_tolerance: 5 } })
    });
    if (!predRes.ok) {
      const err = await predRes.json().catch(() => ({}));
      const detail = err?.detail || err?.error || JSON.stringify(err);
      console.error(`Replicate ${predRes.status}:`, detail);
      return res.status(502).json({ error: `Transformation failed (${predRes.status}): ${detail}` });
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
  sendNotification(
    `New Viewframe signup — ${email}`,
    `<p><strong>Email:</strong> ${email}<br><strong>Role:</strong> ${role || 'not specified'}</p>`
  );
  res.json({ ok: true });
});


// ── POST /api/quote-request ───────────────────────────────────────────────────
app.post('/api/quote-request', (req, res) => {
  const { name, email, postcode, design } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (!postcode || typeof postcode !== 'string' || postcode.trim().length < 3) {
    return res.status(400).json({ error: 'Postcode required.' });
  }
  const pc = postcode.trim().toUpperCase().slice(0, 10);
  const designItems = Object.keys(design || {}).filter(k => k !== 'estimatedTotal').join(', ');
  const total = (design || {}).estimatedTotal || '—';
  appendLog('quote_requests.jsonl', { ts: new Date().toISOString(), name: (name||'').slice(0,100), email, postcode: pc, design: design || {} });

  // Notify owner
  sendNotification(`New quote request — ${pc}`,
    `<p><b>Email:</b> ${email}</p><p><b>Postcode:</b> ${pc}</p><p><b>Design:</b> ${designItems}</p><p><b>Estimated total:</b> ${total}</p>`
  );
  // Confirm to user
  sendEmailTo(email, 'Your Viewframe design has been saved',
    `<p>Thanks for using Viewframe.</p>
    <p>Your design has been saved and a local FENSA-registered installer will be in touch within 24 hours with a fixed quote.</p>
    <p><b>Your design:</b> ${designItems || 'See configurator'}<br><b>Estimated price:</b> ${total}</p>
    <p>If you have any questions, reply to this email or contact us at <a href="mailto:hello@viewframe.co.uk">hello@viewframe.co.uk</a>.</p>
    <p>— The Viewframe team</p>`
  );
  res.json({ ok: true });
});

// ── POST /api/book-survey ─────────────────────────────────────────────────────
app.post('/api/book-survey', (req, res) => {
  const { name, email, phone, postcode, date, time } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Name required.' });
  }
  const pc = (postcode || '').trim().toUpperCase().slice(0, 10);
  appendLog('survey_bookings.jsonl', {
    ts: new Date().toISOString(), name: name.trim().slice(0,100), email,
    phone: (phone||'').slice(0,30), postcode: pc,
    date: (date||'').slice(0,20), time: (time||'').slice(0,20)
  });

  // Notify owner
  sendNotification(`Survey booking — ${name.trim()} (${pc})`,
    `<p><b>Name:</b> ${name.trim()}</p><p><b>Email:</b> ${email}</p><p><b>Phone:</b> ${phone||'—'}</p><p><b>Postcode:</b> ${pc}</p><p><b>Preferred date:</b> ${date||'Any'} ${time||''}</p>`
  );
  // Confirm to user
  sendEmailTo(email, 'Your free home survey is booked — Viewframe',
    `<p>Hi ${name.trim()},</p>
    <p>Your free home survey request has been received. A local FENSA-registered installer will be in touch within 24 hours to confirm your appointment.</p>
    ${date ? `<p><b>Requested date:</b> ${date}${time ? ', ' + time : ''}</p>` : ''}
    <p>If you need to change anything, just reply to this email or contact us at <a href="mailto:hello@viewframe.co.uk">hello@viewframe.co.uk</a>.</p>
    <p>— The Viewframe team</p>`
  );
  res.json({ ok: true });
});

// ── GET /api/dashboard ────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const token = process.env.DASHBOARD_TOKEN;
  if (token && req.query.token !== token) return res.status(401).json({ error: 'Unauthorised.' });
  function readLog(file) {
    const fp = path.join(__dirname, 'data', file);
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  const quotes = readLog('quote_requests.jsonl');
  const surveys = readLog('survey_bookings.jsonl');
  const leads = readLog('leads.jsonl');
  const waitlist = readLog('waitlist.jsonl');
  res.json({
    totals: { quotes: quotes.length, surveys: surveys.length, leads: leads.length, waitlist: waitlist.length },
    recentQuotes: quotes.slice(-20).reverse(),
    recentSurveys: surveys.slice(-20).reverse(),
    recentLeads: leads.slice(-10).reverse()
  });
});

// ── POST /api/lead ────────────────────────────────────────────────────────────
// Rich lead from onboarding: includes chosen colour, style, and element count
app.post('/api/lead', (req, res) => {
  const { name, email, postcode, phone, colour, style, elements } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (!postcode || typeof postcode !== 'string' || postcode.trim().length < 3) {
    return res.status(400).json({ error: 'Postcode required.' });
  }
  const pc = postcode.trim().toUpperCase().slice(0, 10);
  appendLog('leads.jsonl', {
    ts: new Date().toISOString(),
    name: (name || '').slice(0, 100),
    email,
    postcode: pc,
    phone: (phone || '').slice(0, 20),
    colour: (colour || '').slice(0, 50),
    style: (style || '').slice(0, 50),
    elements: elements || 0
  });
  sendNotification(
    `🏠 New lead — ${pc} — ${colour || '?'} ${style || '?'}`,
    `<p><strong>Name:</strong> ${name || 'Not given'}<br>
     <strong>Email:</strong> ${email}<br>
     <strong>Postcode:</strong> ${pc}<br>
     <strong>Phone:</strong> ${phone || 'Not given'}<br>
     <strong>Frame colour:</strong> ${colour || 'Not set'}<br>
     <strong>Window style:</strong> ${style || 'Not set'}<br>
     <strong>Elements placed:</strong> ${elements || 0}</p>
     <p>This homeowner designed their windows before requesting a quote.</p>`
  );
  res.json({ ok: true });
});

// ── POST /api/contact ─────────────────────────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, email, role, message } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  if (!message || typeof message !== 'string' || message.trim().length < 5) {
    return res.status(400).json({ error: 'Message required.' });
  }
  appendLog('contacts.jsonl', {
    ts: new Date().toISOString(),
    name: (name || '').slice(0, 100),
    email,
    role: (role || '').slice(0, 50),
    message: message.trim().slice(0, 2000)
  });
  sendNotification(
    `New Viewframe message from ${name || email}`,
    `<p><strong>Name:</strong> ${name || '—'}<br>
     <strong>Email:</strong> ${email}<br>
     <strong>Role:</strong> ${role || '—'}<br>
     <strong>Message:</strong></p>
     <p>${message.trim().replace(/\n/g, '<br>')}</p>`
  );
  res.json({ ok: true });
});

// ── POST /api/event ───────────────────────────────────────────────────────────
app.post('/api/event', (req, res) => {
  const { name, props } = req.body || {};
  if (!name || typeof name !== 'string' || name.length > 100) return res.status(400).end();
  appendLog('events.jsonl', { ts: new Date().toISOString(), name: name.slice(0,100), props: props || {} });
  res.json({ ok: true });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── START ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Viewframe running on http://localhost:${PORT}`);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  console.log('REPLICATE_API_TOKEN:', process.env.REPLICATE_API_TOKEN ? 'SET' : 'MISSING');
});
