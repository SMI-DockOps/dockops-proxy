require('dotenv').config();
const express = require('express');
const cors = require('cors');
 
const app = express();
app.use(cors());
app.use(express.json());
 
const SS_BASE = 'https://api.smartsheet.com/2.0';
const HEADERS = {
  Authorization: `Bearer ${process.env.SMARTSHEET_TOKEN}`,
  'Content-Type': 'application/json'
};
 
const SHEETS = {
  schedule: process.env.SHEET_SCHEDULE,
  berths:   process.env.SHEET_BERTHS,
  pipeline: process.env.SHEET_PIPELINE
};
 
// ── Helper: fetch a full sheet from Smartsheet ──────────────────
async function fetchSheet(sheetId) {
  const res = await fetch(`${SS_BASE}/sheets/${sheetId}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Smartsheet error: ${res.status}`);
  return res.json();
}
 
// ── Helper: convert Smartsheet rows → flat JS objects ──────────
function parseRows(sheet) {
  const cols = {};
  sheet.columns.forEach(c => cols[c.id] = c.title);
  return (sheet.rows || []).map(row => {
    const obj = { _rowId: row.id };
    row.cells.forEach(cell => {
      const key = cols[cell.columnId];
      if (key) obj[key] = cell.value ?? null;
    });
    return obj;
  });
}
 
// ── Helper: build Smartsheet cells from flat object ────────────
function buildCells(sheet, data) {
  const colMap = {};
  sheet.columns.forEach(c => colMap[c.title] = c.id);
  return Object.entries(data)
    .filter(([k]) => k !== '_rowId' && colMap[k] !== undefined)
    .map(([k, v]) => ({ columnId: colMap[k], value: v }));
}
 
// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'DockOps Proxy Online', timestamp: new Date().toISOString() });
});
 
// ─────────────────────────────────────────────────────────────
// BERTHS
// ─────────────────────────────────────────────────────────────
app.get('/api/berths', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.berths);
    res.json(parseRows(sheet));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.put('/api/berths/:rowId', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.berths);
    const cells = buildCells(sheet, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.berths}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ─────────────────────────────────────────────────────────────
// SCHEDULE
// ─────────────────────────────────────────────────────────────
app.get('/api/schedule', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.schedule);
    res.json(parseRows(sheet));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/api/schedule', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.schedule);
    const cells = buildCells(sheet, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.schedule}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.put('/api/schedule/:rowId', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.schedule);
    const cells = buildCells(sheet, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.schedule}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.delete('/api/schedule/:rowId', async (req, res) => {
  try {
    const r = await fetch(
      `${SS_BASE}/sheets/${SHEETS.schedule}/rows?rowIds=${req.params.rowId}&ignoreRowsNotFound=true`,
      { method: 'DELETE', headers: HEADERS }
    );
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ─────────────────────────────────────────────────────────────
// PIPELINE
// ─────────────────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.pipeline);
    res.json(parseRows(sheet));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/api/pipeline', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.pipeline);
    const cells = buildCells(sheet, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.pipeline}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.put('/api/pipeline/:rowId', async (req, res) => {
  try {
    const sheet = await fetchSheet(SHEETS.pipeline);
    const cells = buildCells(sheet, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.pipeline}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

 // Shipyard Intake — writes new client lead to Smartsheet
app.post('/api/intake', async (req, res) => {
  try {
    const { sheetId, row } = req.body;
    const r = await fetch(
      `${SS_BASE}/sheets/${sheetId}/rows`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify([row])
      }
    );
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DockOps Proxy running on port ${PORT}`));
