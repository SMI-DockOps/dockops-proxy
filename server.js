require('dotenv').config();
const express = require('express');
const cors    = require('cors');

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
  pipeline: process.env.SHEET_PIPELINE,
  leads:    process.env.SHEET_LEADS,
  clients:  process.env.SHEET_CLIENTS,   // NEW: Clients & Vessels sheet
};

// ─────────────────────────────────────────────────────────────
// TITLE CASE NORMALIZATION
// Applied to every Vessel Name write across ALL endpoints.
// Minor words stay lowercase unless they open the name.
// Examples: "nordic star" → "Nordic Star"
//           "JAMES T QUIGG" → "James T Quigg"
//           "vessel of the sea" → "Vessel of the Sea"
// ─────────────────────────────────────────────────────────────
const MINOR_WORDS = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as']);

function toTitleCase(str) {
  if (!str || typeof str !== 'string') return str;
  return str.trim().split(/\s+/).map((word, i) => {
    const lower = word.toLowerCase();
    if (i !== 0 && MINOR_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

// Normalize Vessel Name in any payload — modifies in place, safe to call on all writes
function normalizeVesselName(data) {
  if (data && data['Vessel Name']) {
    data['Vessel Name'] = toTitleCase(data['Vessel Name']);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// CACHE
// Two layers:
//   dataCache   — full sheet rows, 60s TTL, invalidated on writes
//   colCache    — column title→id map, permanent until restart
// ─────────────────────────────────────────────────────────────
const DATA_TTL  = 60 * 1000;
const dataCache = {};
const colCache  = {};

function cacheIsFresh(sheetId) {
  const entry = dataCache[sheetId];
  return entry && (Date.now() - entry.ts < DATA_TTL);
}

function invalidate(sheetId) {
  delete dataCache[sheetId];
}

// ── Raw Smartsheet fetch ─────────────────────────────────────
async function fetchSheet(sheetId) {
  const res = await fetch(`${SS_BASE}/sheets/${sheetId}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Smartsheet error ${res.status} on sheet ${sheetId}`);
  return res.json();
}

// ── Cached sheet rows ────────────────────────────────────────
async function getRows(sheetId) {
  if (cacheIsFresh(sheetId)) return dataCache[sheetId].rows;
  const sheet = await fetchSheet(sheetId);
  const rows  = parseRows(sheet);
  dataCache[sheetId] = { rows, ts: Date.now() };
  if (!colCache[sheetId]) {
    const map = {};
    sheet.columns.forEach(c => { map[c.title] = c.id; });
    colCache[sheetId] = map;
  }
  return rows;
}

// ── Cached column map ────────────────────────────────────────
async function getColMap(sheetId) {
  if (colCache[sheetId]) return colCache[sheetId];
  const sheet = await fetchSheet(sheetId);
  const map   = {};
  sheet.columns.forEach(c => { map[c.title] = c.id; });
  colCache[sheetId] = map;
  if (!cacheIsFresh(sheetId)) {
    dataCache[sheetId] = { rows: parseRows(sheet), ts: Date.now() };
  }
  return map;
}

// ── Helper: rows → flat JS objects ──────────────────────────
function parseRows(sheet) {
  const cols = {};
  sheet.columns.forEach(c => { cols[c.id] = c.title; });
  return (sheet.rows || []).map(row => {
    const obj = { _rowId: row.id };
    row.cells.forEach(cell => {
      const key = cols[cell.columnId];
      if (key) obj[key] = cell.value ?? null;
    });
    return obj;
  });
}

// ── Helper: flat object → Smartsheet cells ──────────────────
function buildCells(colMap, data) {
  return Object.entries(data)
    .filter(([k]) => k !== '_rowId' && colMap[k] !== undefined)
    .map(([k, v]) => ({ columnId: colMap[k], value: v }));
}

// ─────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────
const PROXY_TOKEN = process.env.PROXY_TOKEN;
app.use((req, res, next) => {
  if (!PROXY_TOKEN) return next();
  if (req.path === '/' || req.path === '/api/cache/status') return next();
  if (req.path === '/api/intake') return next(); // public form — no auth
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${PROXY_TOKEN}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.get('/', (req, res) => {
  res.json({ status: 'DockOps Proxy Online', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// CACHE STATUS  (GET /api/cache/status)
// ─────────────────────────────────────────────────────────────
app.get('/api/cache/status', (req, res) => {
  const sheetName = id => Object.entries(SHEETS).find(([,v]) => v === id)?.[0] ?? id;
  const status = {};
  Object.entries(dataCache).forEach(([id, entry]) => {
    const ageMs  = Date.now() - entry.ts;
    const ageSec = Math.round(ageMs / 1000);
    status[sheetName(id)] = {
      fresh:     ageMs < DATA_TTL,
      age:       `${ageSec}s`,
      expiresIn: `${Math.max(0, Math.round((DATA_TTL - ageMs) / 1000))}s`,
      rows:      entry.rows.length,
    };
  });
  res.json({
    ttl:     `${DATA_TTL / 1000}s`,
    sheets:  status,
    colMaps: Object.keys(colCache).map(sheetName),
  });
});

// ─────────────────────────────────────────────────────────────
// BERTHS
// ─────────────────────────────────────────────────────────────
app.get('/api/berths', async (req, res) => {
  try {
    res.json(await getRows(SHEETS.berths));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/berths/:rowId', async (req, res) => {
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.berths);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.berths}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    if (r.ok) invalidate(SHEETS.berths);
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
    res.json(await getRows(SHEETS.schedule));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule', async (req, res) => {
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.schedule);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.schedule}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    if (r.ok) invalidate(SHEETS.schedule);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/schedule/:rowId', async (req, res) => {
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.schedule);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.schedule}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    if (r.ok) invalidate(SHEETS.schedule);
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
    if (r.ok) invalidate(SHEETS.schedule);
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
    res.json(await getRows(SHEETS.pipeline));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline', async (req, res) => {
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.pipeline);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.pipeline}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    if (r.ok) invalidate(SHEETS.pipeline);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pipeline/:rowId', async (req, res) => {
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.pipeline);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.pipeline}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    if (r.ok) invalidate(SHEETS.pipeline);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pipeline/:rowId', async (req, res) => {
  try {
    const r = await fetch(
      `${SS_BASE}/sheets/${SHEETS.pipeline}/rows?rowIds=${req.params.rowId}&ignoreRowsNotFound=true`,
      { method: 'DELETE', headers: HEADERS }
    );
    if (r.ok) invalidate(SHEETS.pipeline);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// LEADS  (Shipyard Intake — Client Leads sheet)
// ─────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  if (!SHEETS.leads) return res.status(503).json({ error: 'SHEET_LEADS not configured' });
  try {
    res.json(await getRows(SHEETS.leads));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:rowId', async (req, res) => {
  if (!SHEETS.leads) return res.status(503).json({ error: 'SHEET_LEADS not configured' });
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.leads);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.leads}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    if (r.ok) invalidate(SHEETS.leads);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// INTAKE  (public — no auth required)
// Accepts field key/value pairs; sheetId hardcoded server-side.
// Also auto-creates or updates a Clients & Vessels record when
// a vessel name is present, so every intake form submission
// is reflected in the CRM immediately.
// ─────────────────────────────────────────────────────────────
app.post('/api/intake', async (req, res) => {
  if (!SHEETS.leads) return res.status(503).json({ error: 'SHEET_LEADS not configured' });
  try {
    const colMap = await getColMap(SHEETS.leads);
    let cells;
    let flatData = {}; // field-name keyed version for CRM upsert

    // ── Legacy format from website form ──────────────────────────
    // Form sends: { sheetId, row: { cells: [{columnId, value}], toBottom } }
    // The sheetId from the client is IGNORED — we always use SHEETS.leads.
    // We accept the pre-built cells directly since they already reference
    // the correct column IDs for the Leads sheet.
    if (req.body.row && Array.isArray(req.body.row.cells)) {
      cells = req.body.row.cells;

      // Inject Lead Status = 'New — Needs Review' if the form didn't include it
      const statusColId = colMap['Lead Status'];
      if (statusColId && !cells.some(c => c.columnId === statusColId)) {
        cells = [...cells, { columnId: statusColId, value: 'New — Needs Review' }];
      }

      // Build a reverse map (columnId → column name) so we can extract
      // field values for the CRM upsert without knowing the IDs in advance
      const idToName = Object.fromEntries(Object.entries(colMap).map(([k, v]) => [v, k]));
      cells.forEach(cell => {
        const name = idToName[cell.columnId];
        if (name) flatData[name] = cell.value;
      });

    // ── Flat field-name format (future/internal calls) ────────────
    } else {
      normalizeVesselName(req.body);
      cells   = buildCells(colMap, req.body);
      flatData = req.body;
    }

    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.leads}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    const data = await r.json();

    // Auto-create/update Clients & Vessels record from intake data
    const vesselName = flatData['Vessel Name'] || flatData['Vessel'] || '';
    if (r.ok && vesselName && SHEETS.clients) {
      try {
        await upsertClientRecord({
          'Vessel Name':     toTitleCase(vesselName),
          'First Name':      flatData['First Name']  || '',
          'Last Name':       flatData['Last Name']   || '',
          'Owner / Company': flatData['Company / Vessel Owner'] || flatData['Company'] || '',
          'Email':           flatData['Email Address'] || flatData['Email'] || '',
          'Phone':           flatData['Phone Number']  || flatData['Phone']  || '',
          'Preferred Yard':  normalizeYard(flatData['Preferred Yard'] || ''),
          'Client Status':   'Prospect',
          'Source':          'Intake Form',
        });
      } catch (e) {
        // Never fail an intake submission because of a CRM write error
        console.warn('Auto-create client record failed:', e.message);
      }
    }

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CLIENTS & VESSELS
// ─────────────────────────────────────────────────────────────

// Helper: normalize yard string to match Clients & Vessels PICKLIST values
function normalizeYard(yard) {
  const map = {
    'ballard':           'Ballard',
    'ballard (seattle)': 'Ballard',
    'anacortes':         'Anacortes',
    'no preference':     'No Preference',
    '':                  'No Preference',
  };
  return map[(yard || '').toLowerCase()] || 'No Preference';
}

// Helper: find an existing client record by vessel name (case-insensitive)
async function findClientByVesselName(vesselName) {
  const rows = await getRows(SHEETS.clients);
  const search = (vesselName || '').trim().toLowerCase();
  return rows.find(r => (r['Vessel Name'] || '').toLowerCase() === search) || null;
}

// Helper: create or update a Clients & Vessels record
// Called by /api/intake. On match, only fills in BLANK fields —
// never overwrites data a rep has already entered.
async function upsertClientRecord(data) {
  normalizeVesselName(data);
  const existing = await findClientByVesselName(data['Vessel Name']);

  if (existing) {
    // Only write fields that are currently blank in Smartsheet
    const updates = {};
    Object.entries(data).forEach(([k, v]) => {
      if (v && (existing[k] === null || existing[k] === undefined || existing[k] === '')) {
        updates[k] = v;
      }
    });
    if (Object.keys(updates).length > 0) {
      const colMap = await getColMap(SHEETS.clients);
      const cells  = buildCells(colMap, updates);
      const r = await fetch(`${SS_BASE}/sheets/${SHEETS.clients}/rows`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify([{ id: existing._rowId, cells }])
      });
      if (r.ok) invalidate(SHEETS.clients);
    }
    return existing;
  } else {
    // New vessel — create the record
    const colMap = await getColMap(SHEETS.clients);
    const cells  = buildCells(colMap, data);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.clients}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    if (r.ok) invalidate(SHEETS.clients);
    return r.json();
  }
}

// ── GET /api/clients — all records ──────────────────────────
app.get('/api/clients', async (req, res) => {
  if (!SHEETS.clients) return res.status(503).json({ error: 'SHEET_CLIENTS not configured' });
  try {
    res.json(await getRows(SHEETS.clients));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/clients/search?q= — autocomplete ───────────────
// Returns up to 10 matching vessel records for the UI dropdown.
// MUST be defined before /api/clients/:rowId to avoid Express
// treating "search" as a rowId parameter.
app.get('/api/clients/search', async (req, res) => {
  if (!SHEETS.clients) return res.status(503).json({ error: 'SHEET_CLIENTS not configured' });
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const rows = await getRows(SHEETS.clients);
    const results = rows
      .filter(r => r['Vessel Name'] && r['Vessel Name'].toLowerCase().includes(q))
      .map(r => ({
        _rowId:       r._rowId,
        vesselName:   r['Vessel Name'],
        ownerCompany: r['Owner / Company'] || '',
        vesselType:   r['Vessel Type']     || '',
        loa:          r['LOA (ft)']        || '',
        clientStatus: r['Client Status']   || '',
      }))
      .slice(0, 10);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/clients/:rowId — single record + joined history ─
// Returns the client record plus all matching rows from
// Schedule, Leads, and Pipeline, joined by Vessel Name.
app.get('/api/clients/:rowId', async (req, res) => {
  if (!SHEETS.clients) return res.status(503).json({ error: 'SHEET_CLIENTS not configured' });
  try {
    const rows   = await getRows(SHEETS.clients);
    const client = rows.find(r => r._rowId === parseInt(req.params.rowId));
    if (!client) return res.status(404).json({ error: 'Client record not found' });

    const vesselName = (client['Vessel Name'] || '').toLowerCase();

    // Fetch all related sheets in parallel for performance
    const [scheduleRows, leadsRows, pipelineRows] = await Promise.all([
      SHEETS.schedule ? getRows(SHEETS.schedule) : Promise.resolve([]),
      SHEETS.leads    ? getRows(SHEETS.leads)    : Promise.resolve([]),
      SHEETS.pipeline ? getRows(SHEETS.pipeline) : Promise.resolve([]),
    ]);

    // Schedule history — sorted most recent first
    const scheduleHistory = scheduleRows
      .filter(r => (r['Vessel Name'] || '').toLowerCase() === vesselName)
      .map(r => ({
        berth:     r['Berth']          || '',
        yard:      r['Yard']           || '',
        arrival:   r['Arrival Date']   || '',
        departure: r['Departure Date'] || '',
        loa:       r['LOA (ft)']       || '',
      }))
      .sort((a, b) => new Date(b.arrival) - new Date(a.arrival));

    // Leads history
    const leadsHistory = leadsRows
      .filter(r => (r['Vessel Name'] || '').toLowerCase() === vesselName)
      .map(r => ({
        _rowId:    r._rowId,
        status:    r['Lead Status']     || '',
        services:  r['Services Needed'] || r['Services'] || '',
        submitted: r['Submission Date'] || r['Date Submitted'] || '',
        rep:       r['Assigned Rep']    || '',
      }));

    // Pipeline history
    const pipelineHistory = pipelineRows
      .filter(r => (r['Vessel Name'] || '').toLowerCase() === vesselName)
      .map(r => ({
        _rowId:  r._rowId,
        quarter: r['Quarter']   || '',
        value:   r['Value ($)'] || 0,
        status:  r['Status']    || '',
        yard:    r['Yard']      || '',
        berth:   r['Berth']     || '',
        period:  r['Period']    || '',
      }));

    res.json({
      ...client,
      _history: {
        schedule:    scheduleHistory,
        leads:       leadsHistory,
        pipeline:    pipelineHistory,
        totalVisits: scheduleHistory.length,
        firstVisit:  scheduleHistory.length ? scheduleHistory[scheduleHistory.length - 1].arrival : null,
        lastVisit:   scheduleHistory.length ? scheduleHistory[0].departure : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/clients — create new record ───────────────────
app.post('/api/clients', async (req, res) => {
  if (!SHEETS.clients) return res.status(503).json({ error: 'SHEET_CLIENTS not configured' });
  try {
    normalizeVesselName(req.body);
    if (!req.body['Vessel Name']) {
      return res.status(400).json({ error: 'Vessel Name is required' });
    }
    // Duplicate guard — return 409 with the existing record so the UI can link to it
    const existing = await findClientByVesselName(req.body['Vessel Name']);
    if (existing) {
      return res.status(409).json({
        error: `A record for "${req.body['Vessel Name']}" already exists`,
        existing,
      });
    }
    if (!req.body['Source']) req.body['Source'] = 'Manual Entry';
    const colMap = await getColMap(SHEETS.clients);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.clients}/rows`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify([{ cells, toBottom: true }])
    });
    if (r.ok) invalidate(SHEETS.clients);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/clients/:rowId — update record ─────────────────
app.put('/api/clients/:rowId', async (req, res) => {
  if (!SHEETS.clients) return res.status(503).json({ error: 'SHEET_CLIENTS not configured' });
  try {
    normalizeVesselName(req.body);
    const colMap = await getColMap(SHEETS.clients);
    const cells  = buildCells(colMap, req.body);
    const r = await fetch(`${SS_BASE}/sheets/${SHEETS.clients}/rows`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify([{ id: parseInt(req.params.rowId), cells }])
    });
    if (r.ok) invalidate(SHEETS.clients);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DOCK SCHEDULE IMPORT  (POST /api/schedule-import)
// Receives vessel stays parsed from a PM's Dock Schedule Excel file
// (parsing happens in import.html). Always writes to SHEETS.schedule —
// never to a client-supplied sheet.
//   dryRun: true  → returns what WOULD change, writes nothing
//   dryRun: false → applies the changes
// Rules:
//   • Only Excel-owned fields are written. Work Order, Notes, Beam, Draft
//     are never touched, so DockOps edits survive every import.
//   • Hand-entered rows (blank Import Key) are matched and adopted when
//     yard + berth + vessel + overlapping dates line up. Unmatched
//     hand-entered rows are reported, never deleted.
//   • Imported rows that disappear from the Excel file are removed, but
//     only for the same yard and only inside the file's date range.
// ─────────────────────────────────────────────────────────────
const IMPORT_REQUIRED_COLS = ['Import Key', 'Actual Days', 'Projected Days', 'Waived Days', 'Shore Power Days'];
const IMPORT_COMPARE_FIELDS = ['Vessel Name', 'Berth', 'Visit Status', 'Arrival Date', 'Departure Date', 'LOA (ft)',
  'Actual Days', 'Projected Days', 'Waived Days', 'Shore Power Days'];

const importNorm  = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const importDate  = v => (v ? String(v).slice(0, 10) : '');
const importSame  = (a, b) => {
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && a != null && b != null && !isNaN(na) && !isNaN(nb)) return na === nb;
  return importNorm(a) === importNorm(b);
};
const importToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const importVisitStatus = (arr, dep, today) => (dep < today ? 'Completed' : arr > today ? 'Upcoming' : 'Active');

function planScheduleImport(existingRows, { yard, coverage, stays }, today) {
  const rows = existingRows.filter(r => r['Yard'] === yard);
  const claimed = new Set();
  const plan = { add: [], update: [], unchanged: 0, remove: [], unmatchedManual: [] };

  for (const s of stays) {
    const key = `${yard}|${s.berth}|${s.arrival}|${importNorm(s.vessel)}`;
    const free = r => !claimed.has(r._rowId);
    let match = rows.find(r => free(r) && r['Import Key'] === key);
    if (!match) {
      match = rows.find(r => free(r)
        && r['Berth'] === s.berth
        && importNorm(r['Vessel Name']) === importNorm(s.vessel)
        && r['Arrival Date'] && r['Departure Date']
        && importDate(r['Arrival Date']) <= s.departure && s.arrival <= importDate(r['Departure Date']));
    }

    const data = {
      'Vessel Name': s.vessel,
      'Yard': yard,
      'Berth': s.berth,
      'Visit Status': importVisitStatus(s.arrival, s.departure, today),
      'Arrival Date': s.arrival,
      'Departure Date': s.departure,
      'Import Key': key,
      'Actual Days': s.actualDays,
      'Projected Days': s.projectedDays,
      'Waived Days': s.waivedDays,
      'Shore Power Days': s.shorePowerDays,
    };
    if (typeof s.loa === 'number') data['LOA (ft)'] = s.loa;
    if (typeof normalizeVesselName === 'function') normalizeVesselName(data);

    const label = { vessel: data['Vessel Name'], berth: s.berth, arrival: s.arrival, departure: s.departure };
    if (!match) { plan.add.push({ ...label, data }); continue; }

    claimed.add(match._rowId);
    const changed = IMPORT_COMPARE_FIELDS.filter(f => data[f] !== undefined && !importSame(
      f.includes('Date') ? importDate(match[f]) : match[f], data[f]));
    if (match['Import Key'] !== key) changed.push(match['Import Key'] ? 'Import Key' : 'Adopted hand-entered row');
    if (changed.length) plan.update.push({ ...label, rowId: match._rowId, changes: changed, data });
    else plan.unchanged++;
  }

  for (const r of rows) {
    if (claimed.has(r._rowId)) continue;
    const arr = importDate(r['Arrival Date']);
    const inRange = arr && arr >= coverage.from && arr <= coverage.to;
    const label = { vessel: r['Vessel Name'], berth: r['Berth'], arrival: arr, departure: importDate(r['Departure Date']) };
    if (r['Import Key']) { if (inRange) plan.remove.push({ ...label, rowId: r._rowId }); }
    else if (inRange) plan.unmatchedManual.push(label);
  }
  return plan;
}

async function smartsheetCall(method, path, body) {
  const r = await fetch(`${SS_BASE}${path}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Smartsheet ${method} failed (${r.status}): ${json.message || 'unknown error'}`);
  return json;
}

app.post('/api/schedule-import', async (req, res) => {
  try {
    const { yard, coverage, stays, dryRun } = req.body || {};
    if (!['Ballard', 'Anacortes'].includes(yard)) return res.status(400).json({ error: 'Yard must be Ballard or Anacortes.' });
    if (!Array.isArray(stays) || !coverage?.from || !coverage?.to) return res.status(400).json({ error: 'Missing stays or date range.' });
    const bad = stays.find(s => !s.vessel || !s.berth || !/^\d{4}-\d{2}-\d{2}$/.test(s.arrival || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.departure || ''));
    if (bad) return res.status(400).json({ error: `Invalid stay record: ${JSON.stringify(bad)}` });

    const sheetId = SHEETS.schedule;
    const colMap = await getColMap(sheetId);
    const missing = IMPORT_REQUIRED_COLS.filter(c => colMap[c] === undefined);
    if (missing.length) return res.status(400).json({ error: `Schedule sheet is missing columns: ${missing.join(', ')}. Add them in Smartsheet, then redeploy the proxy.` });

    invalidate(sheetId);
    const existing = await getRows(sheetId);
    const plan = planScheduleImport(existing, { yard, coverage, stays }, importToday());
    const summary = {
      dryRun: !!dryRun, yard, coverage,
      counts: { add: plan.add.length, update: plan.update.length, unchanged: plan.unchanged, remove: plan.remove.length, unmatchedManual: plan.unmatchedManual.length },
      add: plan.add.map(({ data, ...x }) => x),
      update: plan.update.map(({ data, ...x }) => x),
      remove: plan.remove,
      unmatchedManual: plan.unmatchedManual,
    };
    if (dryRun) return res.json(summary);

    const chunk = (arr, n) => arr.reduce((out, x, i) => (i % n ? out[out.length - 1].push(x) : out.push([x]), out), []);
    for (const part of chunk(plan.update, 200)) {
      await smartsheetCall('PUT', `/sheets/${sheetId}/rows`, part.map(u => ({ id: u.rowId, cells: buildCells(colMap, u.data) })));
    }
    for (const part of chunk(plan.add, 200)) {
      await smartsheetCall('POST', `/sheets/${sheetId}/rows`, part.map(a => ({ toBottom: true, cells: buildCells(colMap, a.data) })));
    }
    for (const part of chunk(plan.remove, 100)) {
      await smartsheetCall('DELETE', `/sheets/${sheetId}/rows?ids=${part.map(x => x.rowId).join(',')}&ignoreRowsNotFound=true`);
    }
    invalidate(sheetId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DockOps Proxy running on port ${PORT}`));
