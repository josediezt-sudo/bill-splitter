require('fs').existsSync('.env') && require('fs').readFileSync('.env','utf8').split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim(); });
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store (primary) + JSON file (backup on disk)
const STORE_FILE = path.join(__dirname, 'sessions.json');
const memStore = new Map();

// Load from disk on startup
try {
  const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  Object.entries(saved).forEach(([k, v]) => memStore.set(k, v));
  console.log(`Loaded ${memStore.size} sessions from disk`);
} catch { /* no file yet */ }

function persistToDisk() {
  const obj = Object.fromEntries(memStore);
  fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
}

// Multer (memory storage for base64)
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Session helpers (atomic in-memory, no race conditions) ---
function getSession(id) {
  return memStore.get(id) || null;
}
function saveSession(id, data) {
  memStore.set(id, data);
  persistToDisk();
}

// --- API: Create session ---
app.post('/api/sessions', (req, res) => {
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
    itemDivisors: {},
    status: 'setup'
  };
  saveSession(id, session);
  res.json({ id });
});

// --- API: Get session ---
app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json(session);
});

// --- API: Update session ---
app.patch('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  const updated = { ...session, ...req.body };
  saveSession(req.params.id, updated);
  res.json(updated);
});

// --- API: OCR with Claude ---
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
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `Analiza esta boleta/ticket de restaurante y extrae todos los ítems con sus precios.
Responde ÚNICAMENTE con un JSON válido con esta estructura exacta (sin texto adicional):
{
  "items": [
    { "id": "1", "name": "Nombre del plato", "price": 70.00, "quantity": 2 }
  ],
  "subtotal": 100.00,
  "tip": 0,
  "total": 100.00
}
- Usa números decimales para precios (no strings)
- price debe ser el TOTAL de esa línea (precio unitario × cantidad). Ejemplo: 2 Ramen a S/35 c/u → price: 70.00, quantity: 2
- Si hay propina en la boleta, inclúyela en "tip"
- Si un ítem aparece múltiples veces, usa quantity > 1 y price = total de esa línea
- id debe ser un número secuencial como string`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    // Extract JSON robustly
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No se pudo extraer JSON de la respuesta');
    const parsed = JSON.parse(match[0]);

    // Ensure unique IDs
    const items = (parsed.items || []).map((item, i) => ({
      id: String(i + 1),
      name: item.name || 'Ítem',
      price: parseFloat(item.price) || 0,
      quantity: parseInt(item.quantity) || 1
    }));

    const updatedSession = {
      ...session,
      items,
      scannedTip: parseFloat(parsed.tip) || 0,
      scannedTotal: parseFloat(parsed.total) || 0,
      tip: { ...session.tip, amount: parseFloat(parsed.tip) || 0 }
    };
    saveSession(req.params.id, updatedSession);
    res.json({ items, tip: parsed.tip || 0, total: parsed.total || 0 });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: 'Error al leer la boleta: ' + err.message });
  }
});

// --- API: Assign items (diner marks their items) ---
app.post('/api/sessions/:id/assign', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const { dinerId, itemIds, manualAmount, itemDivisors: newDivisors } = req.body;

  const assignments = { ...session.assignments };
  const manualAmounts = { ...session.manualAmounts };
  const itemDivisors = { ...(session.itemDivisors || {}) };

  if (manualAmount !== undefined && manualAmount !== null) {
    manualAmounts[dinerId] = parseFloat(manualAmount) || 0;
    delete assignments[dinerId];
    delete itemDivisors[dinerId];
  } else {
    assignments[dinerId] = itemIds || [];
    delete manualAmounts[dinerId];
    if (newDivisors && Object.keys(newDivisors).length > 0) {
      itemDivisors[dinerId] = newDivisors;
    } else {
      delete itemDivisors[dinerId];
    }
  }

  const updated = { ...session, assignments, manualAmounts, itemDivisors };
  saveSession(req.params.id, updated);
  res.json(updated);
});

// --- API: Calculate totals ---
app.get('/api/sessions/:id/totals', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const totals = calculateTotals(session);
  res.json(totals);
});

function calculateTotals(session) {
  const { items, diners, assignments, manualAmounts, tip } = session;
  const itemDivisors = session.itemDivisors || {};

  const itemMap = {};
  items.forEach(item => { itemMap[item.id] = item; });

  // Count how many diners selected each item (fallback when no explicit divisor)
  const itemShareCount = {};
  items.forEach(item => { itemShareCount[item.id] = 0; });
  diners.forEach(diner => {
    const dinerItems = assignments[diner.id] || [];
    dinerItems.forEach(itemId => {
      if (itemShareCount[itemId] !== undefined) itemShareCount[itemId]++;
    });
  });

  const dinerSubtotals = {};
  diners.forEach(diner => {
    let subtotal = 0;
    if (manualAmounts[diner.id] !== undefined) {
      subtotal = manualAmounts[diner.id];
    } else {
      const dinerItems = assignments[diner.id] || [];
      dinerItems.forEach(itemId => {
        const item = itemMap[itemId];
        if (item) {
          const explicitDivisor = itemDivisors[diner.id]?.[itemId];
          const autoDivisor = itemShareCount[itemId] > 0 ? itemShareCount[itemId] : 1;
          const divisor = explicitDivisor || autoDivisor;
          subtotal += item.price / divisor;
        }
      });
    }
    dinerSubtotals[diner.id] = subtotal;
  });

  const grandSubtotal = Object.values(dinerSubtotals).reduce((a, b) => a + b, 0);

  // Tip
  let tipTotal = 0;
  if (tip.mode === 'percent') {
    tipTotal = grandSubtotal * (tip.percent / 100);
  } else {
    tipTotal = parseFloat(tip.amount) || 0;
  }

  // Tip per diner
  const dinerTips = {};
  diners.forEach(diner => {
    if (tip.split === 'equal') {
      dinerTips[diner.id] = diners.length > 0 ? tipTotal / diners.length : 0;
    } else {
      // Proportional
      const ratio = grandSubtotal > 0 ? dinerSubtotals[diner.id] / grandSubtotal : (1 / diners.length);
      dinerTips[diner.id] = tipTotal * ratio;
    }
  });

  // Final totals
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

  return {
    dinerTotals,
    grandSubtotal,
    tipTotal,
    grandTotal: grandSubtotal + tipTotal,
    currency: session.currency,
    currencySymbol: session.currencySymbol
  };
}

// Serve join page
app.get('/join/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍽️  Divisor de Cuentas corriendo en http://localhost:${PORT}`);
  console.log(`📱  Para compartir en red local, usa tu IP local:${PORT}\n`);
});
