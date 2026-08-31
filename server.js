require('fs').existsSync('.env') && require('fs').readFileSync('.env','utf8').split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim(); });
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== PERSISTENCE: MongoDB si MONGODB_URI está configurada, si no, archivos locales =====
const MONGODB_URI = process.env.MONGODB_URI;
let mongoDb = null;

const STORE_FILE = path.join(__dirname, 'sessions.json');
const EXPENSES_FILE = path.join(__dirname, 'expenses.json');
const GMAIL_TOKENS_FILE = path.join(__dirname, 'gmail-tokens.json');

const memStore = new Map();
let expensesDB = { transactions: [] };
let gmailTokens = null;

function persistToDisk() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(memStore), null, 2));
}

function saveExpensesDB() {
  fs.writeFileSync(EXPENSES_FILE, JSON.stringify(expensesDB, null, 2));
}

function stripId(doc) {
  const { _id, ...rest } = doc;
  return rest;
}

function nextExpenseId() {
  const max = expensesDB.transactions.reduce((m, t) => Math.max(m, parseInt(t.id, 10) || 0), 0);
  return String(max + 1);
}

async function loadData() {
  if (MONGODB_URI) {
    try {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      mongoDb = client.db('billsplitter');

      const sessionDocs = await mongoDb.collection('sessions').find({}).toArray();
      sessionDocs.forEach(doc => { const s = stripId(doc); memStore.set(s.id, s); });

      const expenseDocs = await mongoDb.collection('expenses').find({}).toArray();
      expensesDB.transactions = expenseDocs.map(stripId);

      const tokenDoc = await mongoDb.collection('gmailTokens').findOne({ _id: 'main' });
      if (tokenDoc) gmailTokens = stripId(tokenDoc);

      console.log(`MongoDB conectado — ${memStore.size} sesiones, ${expensesDB.transactions.length} gastos cargados`);
      return;
    } catch (err) {
      console.error('No se pudo conectar a MongoDB, usando almacenamiento local en disco:', err.message);
      mongoDb = null;
    }
  }

  try {
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    Object.entries(saved).forEach(([k, v]) => memStore.set(k, v));
  } catch { /* no file yet */ }

  try {
    const saved = JSON.parse(fs.readFileSync(EXPENSES_FILE, 'utf8'));
    expensesDB.transactions = saved.transactions || [];
  } catch { /* fresh start */ }

  try {
    gmailTokens = JSON.parse(fs.readFileSync(GMAIL_TOKENS_FILE, 'utf8'));
  } catch { /* not connected yet */ }

  console.log(`Almacenamiento local en disco — ${memStore.size} sesiones, ${expensesDB.transactions.length} gastos cargados`);
}

const CATEGORIES = [
  'Comida y restaurantes', 'Servicios del hogar', 'Transporte',
  'Salud', 'Ropa', 'Mensualidad mom', 'Entretenimiento', 'Otros'
];

// ===== GMAIL SETUP =====
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/gmail/callback`;
  if (!clientId || !clientSecret) return null;
  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  if (gmailTokens) client.setCredentials(gmailTokens);
  return client;
}

async function saveGmailTokens(tokens) {
  gmailTokens = tokens;
  if (mongoDb) {
    await mongoDb.collection('gmailTokens').replaceOne({ _id: 'main' }, { _id: 'main', ...tokens }, { upsert: true });
  } else {
    fs.writeFileSync(GMAIL_TOKENS_FILE, JSON.stringify(tokens, null, 2));
  }
}

async function clearGmailTokens() {
  gmailTokens = null;
  if (mongoDb) {
    await mongoDb.collection('gmailTokens').deleteOne({ _id: 'main' });
  } else {
    try { fs.unlinkSync(GMAIL_TOKENS_FILE); } catch {}
  }
}

// ===== MULTER =====
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== BILL-SPLITTER HELPERS =====
function getSession(id) { return memStore.get(id) || null; }
async function saveSession(id, data) {
  memStore.set(id, data);
  if (mongoDb) {
    await mongoDb.collection('sessions').replaceOne({ id }, data, { upsert: true });
  } else {
    persistToDisk();
  }
}

// ===== BILL-SPLITTER ROUTES =====
app.post('/api/sessions', async (req, res) => {
  const id = uuidv4().slice(0, 8);
  const session = {
    id,
    currency: req.body.currency || 'PEN',
    currencySymbol: req.body.currencySymbol || 'S/',
    items: [],
    diners: [],
    tip: { mode: 'proportional', amount: 0, percent: 0 },
    assignments: {},
    manualAmounts: {},
    status: 'setup'
  };
  await saveSession(id, session);
  res.json({ id });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json(session);
});

app.patch('/api/sessions/:id', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  const updated = { ...session, ...req.body };
  await saveSession(req.params.id, updated);
  res.json(updated);
});

app.post('/api/sessions/:id/scan', upload.single('receipt'), async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  const client = new Anthropic({ apiKey });
  const base64 = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype || 'image/jpeg';

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `Analiza esta boleta/ticket de restaurante y extrae todos los ítems con sus precios.
Responde ÚNICAMENTE con un JSON válido con esta estructura exacta (sin texto adicional):
{
  "items": [
    { "id": "1", "name": "Nombre del plato", "price": 25.50, "quantity": 1 }
  ],
  "subtotal": 100.00,
  "tip": 0,
  "total": 100.00
}
- Usa números decimales para precios (no strings)
- Si hay propina en la boleta, inclúyela en "tip"
- id debe ser un número secuencial como string`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No se pudo extraer JSON de la respuesta');
    const parsed = JSON.parse(match[0]);

    const items = (parsed.items || []).map((item, i) => ({
      id: String(i + 1),
      name: item.name || 'Ítem',
      price: parseFloat(item.price) || 0,
      quantity: parseInt(item.quantity) || 1
    }));

    const updatedSession = {
      ...session, items,
      scannedTip: parseFloat(parsed.tip) || 0,
      scannedTotal: parseFloat(parsed.total) || 0,
      tip: { ...session.tip, amount: parseFloat(parsed.tip) || 0 }
    };
    await saveSession(req.params.id, updatedSession);
    res.json({ items, tip: parsed.tip || 0, total: parsed.total || 0 });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: 'Error al leer la boleta: ' + err.message });
  }
});

app.post('/api/sessions/:id/assign', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const { dinerId, itemIds, manualAmount } = req.body;
  const assignments = { ...session.assignments };
  const manualAmounts = { ...session.manualAmounts };

  if (manualAmount !== undefined && manualAmount !== null) {
    manualAmounts[dinerId] = parseFloat(manualAmount) || 0;
    delete assignments[dinerId];
  } else {
    assignments[dinerId] = itemIds || [];
    delete manualAmounts[dinerId];
  }

  const updated = { ...session, assignments, manualAmounts };
  await saveSession(req.params.id, updated);
  res.json(updated);
});

app.get('/api/sessions/:id/totals', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json(calculateTotals(session));
});

function calculateTotals(session) {
  const { items, diners, assignments, manualAmounts, tip } = session;
  const itemMap = {};
  items.forEach(item => { itemMap[item.id] = item; });

  const itemShareCount = {};
  items.forEach(item => { itemShareCount[item.id] = 0; });
  diners.forEach(diner => {
    (assignments[diner.id] || []).forEach(itemId => {
      if (itemShareCount[itemId] !== undefined) itemShareCount[itemId]++;
    });
  });

  const dinerSubtotals = {};
  diners.forEach(diner => {
    let subtotal = 0;
    if (manualAmounts[diner.id] !== undefined) {
      subtotal = manualAmounts[diner.id];
    } else {
      (assignments[diner.id] || []).forEach(itemId => {
        const item = itemMap[itemId];
        if (item) {
          const share = itemShareCount[itemId] > 0 ? itemShareCount[itemId] : 1;
          subtotal += (item.price * item.quantity) / share;
        }
      });
    }
    dinerSubtotals[diner.id] = subtotal;
  });

  const grandSubtotal = Object.values(dinerSubtotals).reduce((a, b) => a + b, 0);

  let tipTotal = 0;
  if (tip.mode === 'percent') {
    tipTotal = grandSubtotal * (tip.percent / 100);
  } else {
    tipTotal = parseFloat(tip.amount) || 0;
  }

  const dinerTips = {};
  diners.forEach(diner => {
    if (tip.split === 'equal') {
      dinerTips[diner.id] = diners.length > 0 ? tipTotal / diners.length : 0;
    } else {
      const ratio = grandSubtotal > 0 ? dinerSubtotals[diner.id] / grandSubtotal : (1 / diners.length);
      dinerTips[diner.id] = tipTotal * ratio;
    }
  });

  const dinerTotals = {};
  diners.forEach(diner => {
    dinerTotals[diner.id] = {
      name: diner.name,
      subtotal: dinerSubtotals[diner.id],
      tip: dinerTips[diner.id],
      total: dinerSubtotals[diner.id] + dinerTips[diner.id],
      items: (assignments[diner.id] || []).map(id => itemMap[id]).filter(Boolean),
      isManual: manualAmounts[diner.id] !== undefined
    };
  });

  return { dinerTotals, grandSubtotal, tipTotal, grandTotal: grandSubtotal + tipTotal, currency: session.currency, currencySymbol: session.currencySymbol };
}

// ===== EXPENSE ROUTES =====

// GET /api/expenses?month=2024-01&type=expense&category=X&q=search
app.get('/api/expenses', (req, res) => {
  let txns = [...expensesDB.transactions];
  const { month, type, category, q } = req.query;
  if (month) txns = txns.filter(t => t.date.startsWith(month));
  if (type) txns = txns.filter(t => t.type === type);
  if (category && category !== 'all') txns = txns.filter(t => t.category === category);
  if (q) {
    const s = q.toLowerCase();
    txns = txns.filter(t => t.description.toLowerCase().includes(s) || (t.notes || '').toLowerCase().includes(s));
  }
  txns.sort((a, b) => b.date.localeCompare(a.date));
  res.json(txns);
});

// GET /api/expenses/stats?month=2024-01
app.get('/api/expenses/stats', (req, res) => {
  const { month } = req.query;
  let txns = expensesDB.transactions;
  if (month) txns = txns.filter(t => t.date.startsWith(month));

  const income = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expenses = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  const byCategory = {};
  txns.filter(t => t.type === 'expense').forEach(t => {
    byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
  });

  const top5 = txns.filter(t => t.type === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 5);

  const monthlyTrend = getMonthlyTrend();

  res.json({ income, expenses, balance: income - expenses, byCategory, top5, monthlyTrend });
});

function getMonthlyTrend() {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const txns = expensesDB.transactions.filter(t => t.date.startsWith(key));
    return {
      month: key,
      label: d.toLocaleString('es-PE', { month: 'short', year: '2-digit' }),
      income: txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      expenses: txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    };
  });
}

// GET /api/expenses/categories
app.get('/api/expenses/categories', (req, res) => {
  res.json(CATEGORIES);
});

// POST /api/expenses
app.post('/api/expenses', async (req, res) => {
  const { date, description, amount, type, category, notes, source } = req.body;
  if (!amount || !description || !date) return res.status(400).json({ error: 'Faltan campos requeridos' });
  const txn = {
    id: nextExpenseId(),
    date, description,
    amount: parseFloat(amount),
    type: type || 'expense',
    category: category || 'Otros',
    notes: notes || '',
    source: source || 'manual',
    createdAt: new Date().toISOString()
  };
  expensesDB.transactions.push(txn);
  if (mongoDb) await mongoDb.collection('expenses').insertOne({ ...txn });
  else saveExpensesDB();
  res.json(txn);
});

// PUT /api/expenses/:id
app.put('/api/expenses/:id', async (req, res) => {
  const idx = expensesDB.transactions.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  expensesDB.transactions[idx] = { ...expensesDB.transactions[idx], ...req.body, id: req.params.id };
  if (mongoDb) await mongoDb.collection('expenses').replaceOne({ id: req.params.id }, expensesDB.transactions[idx]);
  else saveExpensesDB();
  res.json(expensesDB.transactions[idx]);
});

// DELETE /api/expenses/:id
app.delete('/api/expenses/:id', async (req, res) => {
  const idx = expensesDB.transactions.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  expensesDB.transactions.splice(idx, 1);
  if (mongoDb) await mongoDb.collection('expenses').deleteOne({ id: req.params.id });
  else saveExpensesDB();
  res.json({ ok: true });
});

// POST /api/expenses/scan — OCR de imagen con Claude Vision
app.post('/api/expenses/scan', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  const client = new Anthropic({ apiKey });
  const base64 = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype || 'image/jpeg';
  const today = new Date().toISOString().split('T')[0];

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `Analiza este comprobante (boleta, factura, ticket, captura de Yape/Plin/transferencia bancaria).
Extrae la información de la transacción y responde ÚNICAMENTE con JSON válido (sin texto adicional):
{
  "date": "YYYY-MM-DD",
  "description": "Descripción corta (máx 60 chars)",
  "amount": 125.50,
  "type": "expense",
  "category": "Comida y restaurantes",
  "notes": ""
}
Categorías disponibles: ${CATEGORIES.join(', ')}
- type: "expense" para gastos/compras/pagos, "income" para ingresos/depósitos/abonos
- Si es una captura de Yape/Plin enviando dinero = expense; recibiendo = income
- Si no encuentras la fecha exacta, usa hoy: ${today}
- amount: número positivo sin símbolo de moneda`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No se pudo extraer JSON');
    const parsed = JSON.parse(match[0]);
    parsed.amount = Math.abs(parseFloat(parsed.amount) || 0);
    if (!CATEGORIES.includes(parsed.category)) parsed.category = 'Otros';
    res.json(parsed);
  } catch (err) {
    console.error('Expense scan error:', err);
    res.status(500).json({ error: 'Error al analizar imagen: ' + err.message });
  }
});

// ===== GMAIL ROUTES =====

app.get('/api/gmail/status', (req, res) => {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (!configured) return res.json({ connected: false, configured: false });
  res.json({ connected: !!(gmailTokens && gmailTokens.access_token), configured: true });
});

app.get('/api/gmail/disconnect', async (req, res) => {
  await clearGmailTokens();
  res.redirect('/dashboard?gmail=disconnected');
});

app.get('/api/gmail/auth', (req, res) => {
  const auth = getOAuth2Client();
  if (!auth) return res.status(500).send('Google OAuth no configurado. Agrega GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.');
  const { google } = require('googleapis');
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?error=gmail_auth_cancelled');
  try {
    const auth = getOAuth2Client();
    const { tokens } = await auth.getToken(code);
    await saveGmailTokens(tokens);
    res.redirect('/dashboard?gmail=connected');
  } catch (err) {
    console.error('Gmail callback error:', err);
    res.redirect('/dashboard?error=gmail_auth_failed');
  }
});

app.post('/api/gmail/sync', async (req, res) => {
  const auth = getOAuth2Client();
  if (!auth) return res.status(500).json({ error: 'Gmail no configurado' });

  try {
    const { google } = require('googleapis');
    const gmail = google.gmail({ version: 'v1', auth });
    const { days = 30 } = req.body;
    const after = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    const bankQuery = [
      'from:notificacionesbcp.com.pe',
      'from:interbank.pe',
      'from:bbvamail.pe',
      'from:bbva.pe',
      'from:scotiabanksms.com.pe',
      'from:yape@bcp.com.pe',
      'from:no-reply@banbif.com.pe'
    ].join(' OR ');

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `(category:purchases OR ${bankQuery}) after:${after}`,
      maxResults: 200
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) return res.json({ found: 0, transactions: [] });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });
    const client = new Anthropic({ apiKey });
    const results = [];

    for (const msg of messages.slice(0, 150)) {
      try {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const payload = detail.data.payload;
        const headers = payload.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const dateHeader = headers.find(h => h.name === 'Date')?.value || '';

        let body = '';
        function extractBody(part) {
          if (part.body && part.body.data) {
            const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
            if (part.mimeType === 'text/plain') return decoded;
            if (part.mimeType === 'text/html') return decoded.replace(/<[^>]+>/g, ' ');
          }
          if (part.parts) {
            for (const p of part.parts) {
              const r = extractBody(p);
              if (r) return r;
            }
          }
          return '';
        }
        body = extractBody(payload);
        body = body.replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (!body) continue;

        const parseRes = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: `Analiza este email bancario peruano y extrae la transacción.
De: ${from}
Asunto: ${subject}
Fecha del email: ${dateHeader}
Contenido: ${body}

Responde ÚNICAMENTE con JSON válido:
{
  "is_transaction": true,
  "date": "YYYY-MM-DD",
  "description": "descripción breve",
  "amount": 0.00,
  "type": "expense",
  "category": "Otros",
  "notes": ""
}
Categorías: ${CATEGORIES.join(', ')}
Si el email NO tiene una transacción clara, responde: {"is_transaction": false}
Si el email es una notificación de intereses, comisiones, mantenimiento de cuenta u otro cargo interno del banco (no una compra o pago a un tercero), responde: {"is_transaction": false} — esos no son gastos de consumo personal.
type: "expense" para compras/pagos/débitos, "income" para abonos/depósitos/transferencias recibidas`
          }]
        });

        const text = parseRes.content[0].text.trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) continue;
        const parsed = JSON.parse(match[0]);
        if (parsed.is_transaction && parsed.amount > 0) {
          if (!CATEGORIES.includes(parsed.category)) parsed.category = 'Otros';
          results.push({ ...parsed, source: 'email', emailId: msg.id });
        }
      } catch { /* skip this email */ }
    }

    res.json({ found: results.length, transactions: results, scanned: Math.min(messages.length, 25) });
  } catch (err) {
    console.error('Gmail sync error:', err);
    if (err.code === 401 || (err.response && err.response.status === 401)) {
      await clearGmailTokens();
      return res.status(401).json({ error: 'Sesión de Gmail expirada. Reconecta Gmail.', needsReauth: true });
    }
    res.status(500).json({ error: 'Error al sincronizar Gmail: ' + err.message });
  }
});

app.post('/api/gmail/import', async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Formato inválido' });

  const imported = transactions.map(t => {
    const txn = {
      id: nextExpenseId(),
      date: t.date,
      description: t.description,
      amount: Math.abs(parseFloat(t.amount) || 0),
      type: t.type || 'expense',
      category: t.category || 'Otros',
      notes: t.notes || '',
      source: 'email',
      createdAt: new Date().toISOString()
    };
    expensesDB.transactions.push(txn);
    return txn;
  });
  if (mongoDb && imported.length) await mongoDb.collection('expenses').insertMany(imported.map(t => ({ ...t })));
  else saveExpensesDB();
  res.json({ imported: imported.length, transactions: imported });
});

// ===== DASHBOARD & JOIN PAGES =====
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/join/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));

loadData().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🍽️  Divisor de Cuentas: http://localhost:${PORT}`);
    console.log(`📊  Dashboard de Gastos: http://localhost:${PORT}/dashboard\n`);
  });
});
