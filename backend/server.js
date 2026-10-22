"use strict";

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto"); // NEW: used for POS shell file names

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5188);
const ALLOWED_ORIGINS = new Set([
  "https://farmgenie.itgenie.online",
  "http://127.0.0.1:5189",
  "http://127.0.0.1:5188", // NEW: offline /pos page calls this service from its own origin
  "http://localhost:5188", // NEW
]);

const APP_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "FarmGeniePOS",
);

fs.mkdirSync(APP_DIR, { recursive: true });

// NEW: folder that holds the saved copy of the POS page (offline fallback)
const SHELL_DIR = path.join(APP_DIR, "pos-shell");
fs.mkdirSync(SHELL_DIR, { recursive: true });
const shellKey = (u) =>
  crypto.createHash("sha1").update(String(u)).digest("hex");

const DB_PATH = path.join(APP_DIR, "offline-invoices.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

// Create tables for a new database.
// Existing databases are upgraded below without dropping rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS offline_bills (
    local_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'synced', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    erpnext_invoice_name TEXT,
    customer TEXT,
    customer_name TEXT,
    company TEXT,
    posting_date TEXT,
    due_date TEXT,
    is_pos INTEGER DEFAULT 0,
    pos_profile TEXT,
    update_stock INTEGER DEFAULT 0,
    grand_total REAL DEFAULT 0,
    rounded_total REAL DEFAULT 0,
    paid_amount REAL DEFAULT 0,
    invoice_status TEXT,
    custom_bill_no TEXT,
    custom_offline INTEGER DEFAULT 0,
    custom_offline_bill_id TEXT,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS offline_bill_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id TEXT NOT NULL,
    item_code TEXT,
    item_name TEXT,
    qty REAL DEFAULT 0,
    discount_percentage REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    rate REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    warehouse TEXT,
    FOREIGN KEY (local_id)
      REFERENCES offline_bills(local_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS offline_bill_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id TEXT NOT NULL,
    mode_of_payment TEXT,
    amount REAL DEFAULT 0,
    FOREIGN KEY (local_id)
      REFERENCES offline_bills(local_id) ON DELETE CASCADE
  );

   CREATE TABLE IF NOT EXISTS offline_opening_entries (
    local_id TEXT PRIMARY KEY,
    entry_name TEXT NOT NULL,
    cash_balance REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Durable offline POS closing entries. Existing invoice and opening tables stay intact.
db.exec(`
  CREATE TABLE IF NOT EXISTS offline_closing_entries (
    local_id TEXT PRIMARY KEY,
    opening_entry_name TEXT NOT NULL UNIQUE,
    cashier TEXT NOT NULL,
    pos_profile TEXT NOT NULL,
    warehouse TEXT,
    company TEXT,
    opening_cash REAL NOT NULL,
    cash_sales REAL NOT NULL,
    expected_cash REAL NOT NULL,
    actual_cash REAL NOT NULL,
    cash_difference REAL NOT NULL,
    notes TEXT,
    denominations_json TEXT NOT NULL,
    posting_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_sync'
      CHECK (status IN ('pending_sync', 'synced')),
    erpnext_name TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_offline_closing_entries_status
    ON offline_closing_entries(status);
`);

// Add columns when upgrading an older offline_bills table.
const existingColumns = new Set(
  db
    .prepare("PRAGMA table_info(offline_bills)")
    .all()
    .map((column) => column.name),
);

const migrations = {
  erpnext_invoice_name: "TEXT",
  customer: "TEXT",
  customer_name: "TEXT",
  company: "TEXT",
  posting_date: "TEXT",
  due_date: "TEXT",
  is_pos: "INTEGER DEFAULT 0",
  pos_profile: "TEXT",
  update_stock: "INTEGER DEFAULT 0",
  grand_total: "REAL DEFAULT 0",
  rounded_total: "REAL DEFAULT 0",
  paid_amount: "REAL DEFAULT 0",
  invoice_status: "TEXT",
  custom_bill_no: "TEXT",
  custom_offline: "INTEGER DEFAULT 0",
  custom_offline_bill_id: "TEXT",
};

for (const [column, definition] of Object.entries(migrations)) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE offline_bills ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_offline_bills_status
    ON offline_bills(status);

  CREATE INDEX IF NOT EXISTS idx_offline_bills_created_at
    ON offline_bills(created_at);

  CREATE INDEX IF NOT EXISTS idx_offline_bill_items_local_id
    ON offline_bill_items(local_id);

  CREATE INDEX IF NOT EXISTS idx_offline_bill_payments_local_id
    ON offline_bill_payments(local_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_bills_erpnext_name
    ON offline_bills(erpnext_invoice_name)
    WHERE erpnext_invoice_name IS NOT NULL
      AND erpnext_invoice_name != '';
`);

// NEW: durable copy of POS master data (cashiers, customers, products, stock)
db.exec(`
  CREATE TABLE IF NOT EXISTS pos_master_data (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// NEW: durable copy of the POS browser data (master data, today's bills, POS state)
db.exec(`
  CREATE TABLE IF NOT EXISTS pos_local_backup (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
const LS_BACKUP_KEYS = new Set([
  "farmgenie_pos_master_data_v1",
  "farmgenie_pos_cached_todays_bills_v1",
  "farmgenie_pos_state_v1",
]);

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-FarmGenie-Local-Request"],
  }),
);

// CHANGED: 4mb -> 50mb so the POS page copy (/api/shell) can be saved
app.use(express.json({ limit: "50mb" }));

app.use((req, res, next) => {
  // CHANGED: /pos and /shell-asset are opened by the browser directly
  // (it cannot send the custom header), so they are exempt. They only
  // serve the saved POS page copy, never invoice data.
  if (
    req.path === "/health" ||
    (req.method === "GET" &&
      (req.path === "/pos" || req.path === "/shell-asset"))
  ) {
    return next();
  }

  if (req.get("X-FarmGenie-Local-Request") !== "farmgenie-pos-v1") {
    return res.status(401).json({
      error: "Missing local request header",
    });
  }

  next();
});

function isValidLocalId(value) {
  return typeof value === "string" && /^(OFFLINE-|ONLINE-)/.test(value);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function invoiceDocument(bill) {
  return bill.invoiceDoc || bill.doc || bill;
}

function numeric(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

const saveBill = db.transaction((bill, requestedStatus) => {
  const now = new Date().toISOString();
  const localId = bill.localId;
  const doc = invoiceDocument(bill);

  const previous = db
    .prepare(
      `
    SELECT status, created_at, erpnext_invoice_name
    FROM offline_bills
    WHERE local_id = ?
  `,
    )
    .get(localId);

  // Never downgrade a synced invoice to pending on a repeated POST.
  const status =
    previous && previous.status === "synced" ? "synced" : requestedStatus;

  const erpNextName = firstValue(
    bill.erpNextName,
    bill.erpnextInvoiceName,
    doc.erpnext_invoice_name,
    doc.name,
    null,
  );

  const createdAt = previous?.created_at || bill.createdAt || now;

  const values = {
    local_id: localId,
    status,
    created_at: createdAt,
    updated_at: now,
    erpnext_invoice_name: erpNextName || previous?.erpnext_invoice_name || null,
    customer: firstValue(doc.customer, bill.customer, null),
    customer_name: firstValue(doc.customer_name, bill.customerName, null),
    company: firstValue(doc.company, bill.company, null),
    posting_date: firstValue(doc.posting_date, null),
    due_date: firstValue(doc.due_date, null),
    is_pos: numeric(doc.is_pos),
    pos_profile: firstValue(doc.pos_profile, null),
    update_stock: numeric(doc.update_stock),
    grand_total: numeric(doc.grand_total ?? bill.grandTotal),
    rounded_total: numeric(doc.rounded_total),
    paid_amount: numeric(doc.paid_amount),
    invoice_status: firstValue(doc.status, null),
    custom_bill_no: firstValue(doc.custom_bill_no, null),
    custom_offline: numeric(doc.custom_offline),
    custom_offline_bill_id: firstValue(
      doc.custom_offline_bill_id,
      localId.startsWith("OFFLINE-") ? localId : null,
    ),
    payload_json: JSON.stringify({
      ...bill,
      status,
      erpNextName: erpNextName || null,
    }),
  };

  db.prepare(
    `
    INSERT INTO offline_bills (
      local_id, status, created_at, updated_at,
      erpnext_invoice_name, customer, customer_name, company,
      posting_date, due_date, is_pos, pos_profile, update_stock,
      grand_total, rounded_total, paid_amount, invoice_status,
      custom_bill_no, custom_offline, custom_offline_bill_id,
      payload_json
    ) VALUES (
      @local_id, @status, @created_at, @updated_at,
      @erpnext_invoice_name, @customer, @customer_name, @company,
      @posting_date, @due_date, @is_pos, @pos_profile, @update_stock,
      @grand_total, @rounded_total, @paid_amount, @invoice_status,
      @custom_bill_no, @custom_offline, @custom_offline_bill_id,
      @payload_json
    )
    ON CONFLICT(local_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      erpnext_invoice_name = COALESCE(
        excluded.erpnext_invoice_name,
        offline_bills.erpnext_invoice_name
      ),
      customer = excluded.customer,
      customer_name = excluded.customer_name,
      company = excluded.company,
      posting_date = excluded.posting_date,
      due_date = excluded.due_date,
      is_pos = excluded.is_pos,
      pos_profile = excluded.pos_profile,
      update_stock = excluded.update_stock,
      grand_total = excluded.grand_total,
      rounded_total = excluded.rounded_total,
      paid_amount = excluded.paid_amount,
      invoice_status = excluded.invoice_status,
      custom_bill_no = excluded.custom_bill_no,
      custom_offline = excluded.custom_offline,
      custom_offline_bill_id = excluded.custom_offline_bill_id,
      payload_json = excluded.payload_json
  `,
  ).run(values);

  // Store child rows when the payload provides them.
  const items = Array.isArray(doc.items) ? doc.items : null;
  if (items) {
    db.prepare("DELETE FROM offline_bill_items WHERE local_id = ?").run(
      localId,
    );

    const insertItem = db.prepare(`
      INSERT INTO offline_bill_items (
        local_id, item_code, item_name, qty,
        discount_percentage, discount_amount,
        rate, amount, warehouse
      ) VALUES (
        @local_id, @item_code, @item_name, @qty,
        @discount_percentage, @discount_amount,
        @rate, @amount, @warehouse
      )
    `);

    for (const item of items) {
      insertItem.run({
        local_id: localId,
        item_code: item.item_code || null,
        item_name: item.item_name || null,
        qty: numeric(item.qty),
        discount_percentage: numeric(item.discount_percentage),
        discount_amount: numeric(item.discount_amount),
        rate: numeric(item.rate),
        amount: numeric(item.amount),
        warehouse: item.warehouse || null,
      });
    }
  }

  const payments = Array.isArray(doc.payments) ? doc.payments : null;

  if (payments) {
    db.prepare("DELETE FROM offline_bill_payments WHERE local_id = ?").run(
      localId,
    );

    const insertPayment = db.prepare(`
      INSERT INTO offline_bill_payments (
        local_id, mode_of_payment, amount
      ) VALUES (
        @local_id, @mode_of_payment, @amount
      )
    `);

    for (const payment of payments) {
      insertPayment.run({
        local_id: localId,
        mode_of_payment: payment.mode_of_payment || null,
        amount: numeric(payment.amount),
      });
    }
  }

  return { localId, status, erpNextName: erpNextName || null };
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "FarmGenie SQLite add-on",
    database: DB_PATH,
  });
});

app.get("/api/offline-bills", (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT payload_json, status, erpnext_invoice_name
    FROM offline_bills
    ORDER BY created_at, local_id
  `,
    )
    .all();

  const bills = [];

  for (const row of rows) {
    try {
      const bill = JSON.parse(row.payload_json);
      bill.status = row.status;
      bill.erpNextName = row.erpnext_invoice_name || bill.erpNextName || null;
      bills.push(bill);
    } catch (error) {
      console.error("Invalid stored invoice JSON:", error.message);
    }
  }

  res.json({ bills });
});

// FARMGENIE_OPENING_CASH_READ_V1
// Read an existing offline opening amount. Never create or modify an entry.
app.get("/api/opening-entry/:localId", (req, res) => {
  try {
    if (req.get("X-FarmGenie-Local-Request") !== "farmgenie-pos-v1") {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const localId = String(req.params.localId || "");

    if (!/^OFFLINE-OPE-[0-9]+$/.test(localId)) {
      return res.status(400).json({ ok: false, error: "Invalid opening ID" });
    }

    const row = db.prepare(`
      SELECT entry_name, cash_balance, status, payload_json
      FROM offline_opening_entries
      WHERE entry_name = ? OR local_id = ?
      LIMIT 1
    `).get(localId, localId);

    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "Opening Entry not found in SQLite"
      });
    }

    const doc = JSON.parse(row.payload_json);

    const amount = Number(row.cash_balance);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(422).json({
        ok: false,
        error: "Invalid saved Opening Cash"
      });
    }

    return res.json({
      ok: true,
      entryName: row.entry_name,
      posProfile: doc.pos_profile,
      cashBalance: amount,
      status: row.status
    });
  } catch (error) {
    console.error("Opening Cash read failed:", error);
    return res.status(500).json({
      ok: false,
      error: "Unable to read Opening Cash"
    });
  }
});

// Save POS opening entries locally while offline
app.post("/api/opening-entry", (req, res) => {
  const { openingEntryDoc, cashBalance, localId } = req.body || {};

  if (
    !openingEntryDoc ||
    openingEntryDoc.doctype !== "POS Opening Entry" ||
    typeof localId !== "string" ||
    !localId.startsWith("OFFLINE-OPE-") ||
    !Number.isFinite(Number(cashBalance)) ||
    Number(cashBalance) < 0
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid opening entry data",
    });
  }

  try {
    const entryName = localId;
    const createdAt = new Date().toISOString();

    db.prepare(
      `
      INSERT INTO offline_opening_entries (
        local_id,
        entry_name,
        cash_balance,
        status,
        payload_json,
        created_at
      )
      VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(local_id) DO NOTHING
    `,
    ).run(
      localId,
      entryName,
      Number(cashBalance),
      JSON.stringify(openingEntryDoc),
      createdAt,
    );

    return res.json({
      ok: true,
      name: entryName,
      status: "pending",
    });
  } catch (error) {
    console.error("Local opening entry save failed:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to save opening entry locally",
    });
  }
});

// Offline closing entries are persisted before a handover receipt can be shown.
// This endpoint does NOT submit to ERPNext or sync pending test invoices.
app.post("/api/offline-closing-entry", (req, res) => {
  const body = req.body || {};
  const localId = String(body.localId || "");
  const openingEntryName = String(body.openingEntryName || "").trim();
  const cashier = String(body.cashier || "").trim();
  const posProfile = String(body.posProfile || "").trim();
  const nums = ["openingCash", "cashSales", "expectedCash", "actualCash"];
  if (
    !/^OFFLINE-CLOSE-[A-Za-z0-9_-]{8,100}$/.test(localId) ||
    !openingEntryName || !cashier || !posProfile ||
    nums.some((key) => !Number.isFinite(body[key]) || body[key] < 0) ||
    Math.abs(body.expectedCash - (body.openingCash + body.cashSales)) > 0.02 ||
    !Array.isArray(body.denominations) || body.denominations.length > 30 ||
    body.denominations.some((row) => !row || !Number.isFinite(row.value) ||
      row.value <= 0 || !Number.isInteger(row.count) || row.count < 0 ||
      !Number.isFinite(row.amount) || Math.abs(row.amount - row.value * row.count) > 0.01)
  ) {
    return res.status(400).json({ok:false,error:"Invalid offline closing entry"});
  }
  const denominationAmount = body.denominations.reduce((sum, row) => sum + row.amount, 0);
  if (Math.abs(denominationAmount - body.actualCash) > 0.02) {
    return res.status(400).json({ok:false,error:"Denomination total does not match actual cash"});
  }
  try {
    const existing = db.prepare(`SELECT local_id, opening_entry_name, status, erpnext_name
      FROM offline_closing_entries WHERE local_id = ? OR opening_entry_name = ?`).get(localId, openingEntryName);
    if (existing) {
      if (existing.local_id !== localId || existing.opening_entry_name !== openingEntryName) {
        return res.status(409).json({ok:false,error:"This opening session has a different saved closing entry"});
      }
      return res.json({ok:true,saved:true,alreadyExisted:true,
        localId:existing.local_id,status:existing.status,erpNextName:existing.erpnext_name});
    }
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO offline_closing_entries (
      local_id, opening_entry_name, cashier, pos_profile, warehouse, company,
      opening_cash, cash_sales, expected_cash, actual_cash, cash_difference,
      notes, denominations_json, posting_date, created_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_sync')`).run(
      localId, openingEntryName, cashier, posProfile,
      String(body.warehouse || ""), String(body.company || ""),
      body.openingCash, body.cashSales, body.expectedCash, body.actualCash,
      body.actualCash - body.expectedCash, String(body.notes || ""),
      JSON.stringify(body.denominations), createdAt.slice(0,10), createdAt
    );
    return res.json({ok:true,saved:true,localId,status:"pending_sync",createdAt});
  } catch(error) {
    console.error("Offline closing entry save failed:", error);
    return res.status(500).json({ok:false,error:"Failed to save closing entry"});
  }
});

app.get("/api/offline-closing-entries", (_req,res) => {
  const rows = db.prepare(`SELECT local_id AS localId, opening_entry_name AS openingEntryName,
    cashier, pos_profile AS posProfile, warehouse, company,
    opening_cash AS openingCash, cash_sales AS cashSales,
    expected_cash AS expectedCash, actual_cash AS actualCash,
    cash_difference AS cashDifference, notes, denominations_json AS denominationsJson,
    posting_date AS postingDate, created_at AS createdAt, status, erpnext_name AS erpNextName
    FROM offline_closing_entries ORDER BY created_at DESC`).all();
  res.json({ok:true,entries:rows.map(({denominationsJson,...row}) => ({
    ...row,denominations:JSON.parse(denominationsJson)
  }))});
});

app.post("/api/offline-bills", (req, res) => {
  const bill = req.body;

  if (!bill || typeof bill !== "object" || !isValidLocalId(bill.localId)) {
    return res.status(400).json({
      error: "A valid OFFLINE- or ONLINE- localId is required",
    });
  }

  try {
    const requestedStatus = bill.status === "synced" ? "synced" : "pending";

    const result = saveBill(bill, requestedStatus);

    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error("SQLite invoice save failed:", error);

    return res.status(500).json({
      error: "SQLite invoice save failed",
    });
  }
});

app.patch("/api/offline-bills/:localId/status", (req, res) => {
  const localId = req.params.localId;
  const status = req.body?.status;
  const erpNextName =
    req.body?.erpNextName || req.body?.erpnextInvoiceName || null;

  if (!isValidLocalId(localId) || !["pending", "synced"].includes(status)) {
    return res.status(400).json({
      error: "Valid invoice ID and pending/synced status are required",
    });
  }

  const existing = db
    .prepare(
      `
    SELECT status, payload_json, erpnext_invoice_name
    FROM offline_bills
    WHERE local_id = ?
  `,
    )
    .get(localId);

  if (!existing) {
    // NEW: the invoice is already confirmed in ERPNext but was never saved in
    // SQLite (for example the local service was stopped while billing offline).
    // Record a small "synced" row so the browser retry queue can finish.
    if (status === "synced" && erpNextName) {
      const stamp = new Date().toISOString();

      try {
        db.prepare(
          `
          INSERT INTO offline_bills (
            local_id, status, created_at, updated_at,
            erpnext_invoice_name, custom_offline_bill_id, payload_json
          ) VALUES (?, 'synced', ?, ?, ?, ?, ?)
        `,
        ).run(
          localId,
          stamp,
          stamp,
          erpNextName,
          localId.startsWith("OFFLINE-") ? localId : null,
          JSON.stringify({
            localId,
            status: "synced",
            erpNextName,
            recoveredWithoutInvoiceDoc: true,
          }),
        );

        return res.json({
          ok: true,
          localId,
          status: "synced",
          updated: true,
          recovered: true,
        });
      } catch (error) {
        console.error("SQLite recovery row failed:", error);

        return res.status(500).json({
          error: "SQLite status update failed",
        });
      }
    }

    return res.status(404).json({
      error: "Invoice not found",
      localId,
    });
  }

  // A synced invoice cannot be downgraded to pending.
  const finalStatus = existing.status === "synced" ? "synced" : status;

  let payload;
  try {
    payload = JSON.parse(existing.payload_json);
  } catch {
    payload = {};
  }

  payload.status = finalStatus;

  if (erpNextName) {
    payload.erpNextName = erpNextName;
  }

  const now = new Date().toISOString();

  try {
    const result = db
      .prepare(
        `
      UPDATE offline_bills
      SET status = ?,
          payload_json = ?,
          erpnext_invoice_name = COALESCE(
            ?, erpnext_invoice_name
          ),
          updated_at = ?
      WHERE local_id = ?
    `,
      )
      .run(finalStatus, JSON.stringify(payload), erpNextName, now, localId);

    return res.json({
      ok: true,
      localId,
      status: finalStatus,
      updated: result.changes > 0,
    });
  } catch (error) {
    console.error("SQLite status update failed:", error);

    return res.status(500).json({
      error: "SQLite status update failed",
    });
  }
});

// ===================================================================
// POS MASTER DATA BACKUP - SAFE MERGE
// Preserves cashiers, products, customers and stock independently.
// ===================================================================

app.post("/api/master-data", (req, res) => {
  const data = req.body?.data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({
      ok: false,
      error: "Valid data object required",
    });
  }

  try {
    const result = db.transaction(() => {
      const existing = db
        .prepare(
          `
        SELECT data_json
        FROM pos_master_data
        WHERE id = 1
      `,
        )
        .get();

      let previous = {};

      if (existing) {
        previous = JSON.parse(existing.data_json);
      }

      const merged = { ...previous };

      // Preserve last nonempty arrays independently.
      for (const key of ["cashiers", "products", "customers"]) {
        if (Array.isArray(data[key]) && data[key].length > 0) {
          merged[key] = data[key];
        } else if (!Array.isArray(merged[key])) {
          merged[key] = [];
        }
      }

      // Preserve previous stock when incoming stock is empty.
      if (
        data.stockData &&
        typeof data.stockData === "object" &&
        !Array.isArray(data.stockData) &&
        Object.keys(data.stockData).length > 0
      ) {
        merged.stockData = data.stockData;
      } else if (!merged.stockData) {
        merged.stockData = {};
      }

      merged.savedAt = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO pos_master_data
          (id, data_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          data_json = excluded.data_json,
          updated_at = excluded.updated_at
      `,
      ).run(JSON.stringify(merged), merged.savedAt);

      return {
        cashiers: merged.cashiers.length,
        products: merged.products.length,
        customers: merged.customers.length,
      };
    })();

    return res.json({
      ok: true,
      message: "Master data saved without empty-array overwrites",
      counts: result,
    });
  } catch (error) {
    console.error("Master data save failed:", error);

    return res.status(500).json({
      ok: false,
      error: "Master data save failed",
    });
  }
});

// ===================================================================
// GET MASTER DATA FROM SQLITE
// ===================================================================

app.get("/api/master-data", (_req, res) => {
  try {
    const row = db
      .prepare(
        `
      SELECT data_json, updated_at
      FROM pos_master_data
      WHERE id = 1
    `,
      )
      .get();

    if (!row) {
      return res.json({
        ok: true,
        data: null,
      });
    }

    return res.json({
      ok: true,
      data: JSON.parse(row.data_json),
      updatedAt: row.updated_at,
    });
  } catch (error) {
    console.error("Master data read failed:", error);

    return res.status(500).json({
      ok: false,
      error: "Master data read failed",
    });
  }
});

// ===================================================================
// NEW: POS BROWSER DATA BACKUP (replaces browser localStorage after a wipe)
// POST /api/ls-backup  { items: { key: "json string" | null } }
// GET  /api/ls-backup  -> { items: { key: "json string" } }
// ===================================================================
app.post("/api/ls-backup", (req, res) => {
  const items = req.body && req.body.items;

  if (!items || typeof items !== "object") {
    return res.status(400).json({ ok: false, error: "items object required" });
  }

  try {
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO pos_local_backup (key, value, updated_at)
      VALUES (@key, @value, @updated_at)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    const remove = db.prepare("DELETE FROM pos_local_backup WHERE key = ?");

    let saved = 0;

    db.transaction(() => {
      for (const [key, value] of Object.entries(items)) {
        if (!LS_BACKUP_KEYS.has(key)) continue;

        if (value === null) {
          remove.run(key);
          continue;
        }

        if (typeof value !== "string" || !value) continue;

        // Never replace a good master-data backup with an empty snapshot.
        if (key === "farmgenie_pos_master_data_v1") {
          try {
            const parsed = JSON.parse(value);
            const hasCashiers =
              Array.isArray(parsed.cashiers) && parsed.cashiers.length > 0;
            const hasProducts =
              Array.isArray(parsed.products) && parsed.products.length > 0;
            if (!hasCashiers && !hasProducts) continue;
          } catch (e) {
            continue;
          }
        }

        upsert.run({ key, value, updated_at: now });
        saved++;
      }
    })();

    return res.json({ ok: true, saved });
  } catch (error) {
    console.error("Browser data backup failed:", error);
    return res.status(500).json({ ok: false, error: "Backup failed" });
  }
});

app.get("/api/ls-backup", (_req, res) => {
  try {
    const rows = db.prepare("SELECT key, value FROM pos_local_backup").all();
    const items = {};
    rows.forEach((r) => {
      items[r.key] = r.value;
    });
    return res.json({ ok: true, items });
  } catch (error) {
    console.error("Browser data restore failed:", error);
    return res.status(500).json({ ok: false, error: "Restore failed" });
  }
});

// ===================================================================
// NEW: POS SHELL BACKUP (offline page fallback after browser data wipe)
// POST /api/shell   -> saves the POS page + its JS/CSS (needs header)
// GET  /pos         -> serves the saved POS page
// GET  /shell-asset -> serves one saved JS/CSS file
// ===================================================================
app.post("/api/shell", (req, res) => {
  const { page, files } = req.body || {};

  if (!page || !Array.isArray(files) || !files.length) {
    return res
      .status(400)
      .json({ ok: false, error: "page and files required" });
  }

  try {
    const existingIndexPath = path.join(SHELL_DIR, "index.json");
    let existingFiles = [];

    try {
      const previousIndex = JSON.parse(
        fs.readFileSync(existingIndexPath, "utf8"),
      );
      existingFiles = Array.isArray(previousIndex.files)
        ? previousIndex.files
        : [];
    } catch (error) {
      existingFiles = [];
    }

    const index = {
      page,
      savedAt: new Date().toISOString(),
      files: [],
    };

    for (const file of existingFiles) {
      if (!file || !file.url) continue;

      const localFile = path.join(SHELL_DIR, shellKey(file.url));

      if (fs.existsSync(localFile)) {
        index.files.push({
          url: file.url,
          type: file.type || "application/octet-stream",
        });
      }
    }

    for (const f of files) {
      if (!f || !f.url) continue;

      const targetFile = path.join(SHELL_DIR, shellKey(f.url));

      // Protect the existing offline POS HTML snapshot.
      // An older browser session must not overwrite it automatically.
      const isMainPOSPage = f.url === page;

      if (isMainPOSPage && fs.existsSync(targetFile)) {
        console.log("[POS SHELL] Existing offline POS page preserved:", f.url);
      } else {
        // Keep the existing asset-saving functionality.
        fs.writeFileSync(targetFile, typeof f.body === "string" ? f.body : "");
      }

      // Preserve original index registration functionality.
      const existing = index.files.find((item) => item.url === f.url);

      if (existing) {
        existing.type = f.type || existing.type;
      } else {
        index.files.push({
          url: f.url,
          type: f.type || "text/plain",
        });
      }
    }

    fs.writeFileSync(path.join(SHELL_DIR, "index.json"), JSON.stringify(index));

    return res.json({ ok: true, count: index.files.length });
  } catch (error) {
    console.error("POS shell save failed:", error);
    return res.status(500).json({ ok: false, error: "Shell save failed" });
  }
});

function readShellIndex() {
  return JSON.parse(
    fs.readFileSync(path.join(SHELL_DIR, "index.json"), "utf8"),
  );
}

app.get("/pos", (_req, res) => {
  try {
    const index = readShellIndex();
    let html = fs.readFileSync(
      path.join(SHELL_DIR, shellKey(index.page)),
      "utf8",
    );

    for (const f of index.files) {
      if (f.url === index.page) continue;

      const target = "/shell-asset?u=" + encodeURIComponent(f.url);
      const forms = new Set([f.url]);

      try {
        const u = new URL(f.url);
        forms.add(u.pathname + u.search); // /assets/x.js?v=1
        forms.add("//" + u.host + u.pathname + u.search); // //cdn/x.css
      } catch (e) {
        /* ignore */
      }

      for (const form of forms) {
        html = html
          .split('"' + form + '"')
          .join('"' + target + '"')
          .split("'" + form + "'")
          .join("'" + target + "'");
      }
    }

    res.set("Cache-Control", "no-store");
    return res.type("html").send(html);
  } catch (error) {
    return res
      .status(404)
      .send("POS page copy not saved yet. Open the POS once while online.");
  }
});

app.get("/shell-asset", (req, res) => {
  try {
    const u = String(req.query.u || "");
    const index = readShellIndex();
    const meta = index.files.find((f) => f.url === u);

    if (!meta) return res.status(404).end();

    res.set("Content-Type", meta.type || "text/plain");
    res.set("Cache-Control", "no-store");
    return res.send(fs.readFileSync(path.join(SHELL_DIR, shellKey(u))));
  } catch (error) {
    return res.status(404).end();
  }
});
// ===================== END POS SHELL BACKUP =====================

// POS history mirror: durable document archive, separate from offline invoice queue.
db.exec(`
 CREATE TABLE IF NOT EXISTS pos_erp_documents (
   doctype TEXT NOT NULL,
   docname TEXT NOT NULL,
   modified TEXT,
   content_json TEXT NOT NULL,
   imported_at TEXT NOT NULL,
   PRIMARY KEY (doctype, docname)
 );
 CREATE INDEX IF NOT EXISTS idx_pos_erp_doctype ON pos_erp_documents(doctype);
 CREATE TABLE IF NOT EXISTS pos_erp_sync_state (
   doctype TEXT PRIMARY KEY,
   imported INTEGER NOT NULL DEFAULT 0,
   updated_at TEXT NOT NULL
 );
`);
const POS_IMPORT_TYPES = new Set([
  "Item",
  "Item Group",
  "Item Price",
  "Price List",
  "UOM",
  "Customer",
  "POS Profile",
  "Sales Invoice",
  "POS Opening Entry",
  "POS Closing Entry",
  "Warehouse",
  "Bin",
  "Mode of Payment",
  "Sales Taxes and Charges Template",
  "Loyalty Program",
  "Loyalty Point Entry",
  "Company",
]);
// One persistent table per ERPNext DocType; original mirror remains intact.
// Keep the two-column format already used by manually-created POS tables.
const POS_DOCTYPE_TABLES = Object.freeze({
  Item: "pos_items",
  "Item Group": "pos_item_groups",
  "Item Price": "pos_item_prices",
  "Price List": "pos_price_lists",
  UOM: "pos_uoms",
  Customer: "pos_customers",
  "POS Profile": "pos_profiles",
  "Sales Invoice": "pos_sales_invoices",
  "POS Opening Entry": "pos_erp_opening_entries",
  "POS Closing Entry": "pos_erp_closing_entries",
  Warehouse: "pos_warehouses",
  Bin: "pos_bins",
  "Mode of Payment": "pos_payment_methods",
  "Sales Taxes and Charges Template": "pos_tax_templates",
  "Loyalty Program": "pos_loyalty_programs",
  "Loyalty Point Entry": "pos_loyalty_point_entries",
  Company: "pos_companies",
});
for (const [doctype, table] of Object.entries(POS_DOCTYPE_TABLES)) {
  if (!POS_IMPORT_TYPES.has(doctype)) throw new Error("Invalid mapped DocType");
  // Table names are constants above, never constructed from request parameters.
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
    name TEXT PRIMARY KEY,
    data_json TEXT NOT NULL
  )`);
  const cols = new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((x) => x.name),
  );
  if (!cols.has("name") || !cols.has("data_json")) {
    throw new Error(
      `Existing ${table} table is incompatible: expected name, data_json`,
    );
  }
}
const separateUpserts = new Map(
  Object.entries(POS_DOCTYPE_TABLES).map(([doctype, table]) => [
    doctype,
    db.prepare(`INSERT INTO "${table}" (name, data_json) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET data_json = excluded.data_json`),
  ]),
);

// Safe, repeatable backfill. Mirrors remain the import source and are not deleted.
const backfillPOSSeparateTables = db.transaction(() => {
  const report = [];
  for (const [doctype, table] of Object.entries(POS_DOCTYPE_TABLES)) {
    const rows = db
      .prepare(
        `SELECT docname, content_json FROM pos_erp_documents WHERE doctype = ?`,
      )
      .all(doctype);
    const upsert = separateUpserts.get(doctype);
    for (const row of rows) upsert.run(row.docname, row.content_json);
    const dest = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    report.push({
      doctype,
      table,
      mirrorRows: rows.length,
      tableRows: dest,
      match: dest === rows.length,
    });
  }
  return report;
});

app.post("/api/erp-mirror/backfill-separate", (_req, res) => {
  try {
    const tables = backfillPOSSeparateTables();
    res.json({ ok: true, tables, allMatch: tables.every((x) => x.match) });
  } catch (err) {
    console.error("Separate POS table backfill failed:", err);
    res
      .status(500)
      .json({ ok: false, error: "Backfill failed; transaction rolled back" });
  }
});

app.get("/api/erp-mirror/separate-status", (_req, res) => {
  const tables = Object.entries(POS_DOCTYPE_TABLES).map(([doctype, table]) => {
    const mirrorRows = db
      .prepare("SELECT COUNT(*) AS n FROM pos_erp_documents WHERE doctype = ?")
      .get(doctype).n;
    const tableRows = db
      .prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
      .get().n;
    return {
      doctype,
      table,
      mirrorRows,
      tableRows,
      match: mirrorRows === tableRows,
    };
  });
  res.json({ ok: true, tables, allMatch: tables.every((x) => x.match) });
});

const saveImportBatch = db.transaction((doctype, docs) => {
  const upsert = db.prepare(`
   INSERT INTO pos_erp_documents(doctype,docname,modified,content_json,imported_at)
   VALUES(?,?,?,?,?) ON CONFLICT(doctype,docname) DO UPDATE SET
      modified=excluded.modified,
      content_json=excluded.content_json,
      imported_at=excluded.imported_at
 `);
  const now = new Date().toISOString();
  const separate = separateUpserts.get(doctype);
  let count = 0;
  for (const doc of docs) {
    if (!doc || typeof doc.name !== "string" || !doc.name.trim()) continue;
    const json = JSON.stringify(doc);
    upsert.run(doctype, doc.name, doc.modified || null, json, now);
    separate.run(doc.name, json);
    count++;
  }
  db.prepare(
    `INSERT INTO pos_erp_sync_state(doctype,imported,updated_at)
 VALUES(?,?,?) ON CONFLICT(doctype) DO UPDATE SET
 imported=imported+excluded.imported, updated_at=excluded.updated_at`,
  ).run(doctype, count, now);
  return count;
});
app.post("/api/erp-mirror/batch", (req, res) => {
  const { doctype, documents } = req.body || {};
  if (
    !POS_IMPORT_TYPES.has(doctype) ||
    !Array.isArray(documents) ||
    documents.length > 50
  ) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid doctype or batch (max 50)" });
  }
  try {
    return res.json({ ok: true, saved: saveImportBatch(doctype, documents) });
  } catch (err) {
    console.error("ERP mirror write:", err);
    return res.status(500).json({ ok: false, error: "SQLite write failed" });
  }
});
app.get("/api/erp-mirror/status", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT doctype, COUNT(*) AS rows FROM pos_erp_documents GROUP BY doctype ORDER BY doctype`,
    )
    .all();
  res.json({ ok: true, tables: rows });
});
app.get("/api/erp-mirror/documents", (req, res) => {
  const doctype = String(req.query.doctype || "");
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  if (!POS_IMPORT_TYPES.has(doctype))
    return res.status(400).json({ error: "Invalid doctype" });
  const rows = db
    .prepare(
      `SELECT content_json FROM pos_erp_documents WHERE doctype=? ORDER BY docname LIMIT ? OFFSET ?`,
    )
    .all(doctype, limit, offset);
  res.json({
    ok: true,
    documents: rows.map((r) => JSON.parse(r.content_json)),
  });
});

// Read-only launch readiness check. Does not expose customer/invoice contents.
app.get("/api/offline-readiness", (_req, res) => {
  const shellPath = path.join(SHELL_DIR, "index.json");
  let pageSaved = false,
    assetCount = 0,
    missingAssets = 0;
  try {
    const idx = JSON.parse(fs.readFileSync(shellPath, "utf8"));
    pageSaved = Boolean(
      idx.page && fs.existsSync(path.join(SHELL_DIR, shellKey(idx.page))),
    );
    assetCount = Array.isArray(idx.files) ? idx.files.length : 0;
    missingAssets = (idx.files || []).filter(
      (f) => !fs.existsSync(path.join(SHELL_DIR, shellKey(f.url))),
    ).length;
  } catch (_) {}
  const stored = db
    .prepare("SELECT data_json FROM pos_master_data WHERE id=1")
    .get();
  let master = {};
  try {
    master = stored ? JSON.parse(stored.data_json) : {};
  } catch (_) {}
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM offline_bills WHERE status != 'synced'")
    .get().n;
  const mirrorRows = db
    .prepare(
      "SELECT doctype,COUNT(*) AS n FROM pos_erp_documents GROUP BY doctype ORDER BY doctype",
    )
    .all();
  res.json({
    ok: true,
    shell: { pageSaved, assetCount, missingAssets },
    master: {
      products: (master.products || []).length,
      cashiers: (master.cashiers || []).length,
      customers: (master.customers || []).length,
    },
    pendingBills: pending,
    mirror: mirrorRows,
    note: "A saved shell is not proof that every external script or ERPNext dependency works offline.",
  });
});

app.listen(PORT, HOST, () => {
  console.log(`FarmGenie SQLite add-on listening at http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`POS page copy folder: ${SHELL_DIR}`);
  console.log("Synced invoices are retained in SQLite.");
  console.log("Service is bound to localhost only.");
});
