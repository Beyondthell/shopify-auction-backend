const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

let db;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Init SQLite DB (no async/await)
function initDb() {
  db = new sqlite3.Database('./auction.db', (err) => {
    if (err) {
      console.error('Failed to open database', err);
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS auctions (
        product_id TEXT PRIMARY KEY,
        end_time TEXT,
        highest_bid_amount REAL,
        highest_bidder_name TEXT,
        highest_bidder_email TEXT,
        updated_at TEXT,
        winner_notified_at TEXT
      );
    `, (err) => {
      if (err) console.error('Error creating auctions table', err);
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS bids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        amount REAL NOT NULL,
        created_at TEXT NOT NULL
      );
    `, (err) => {
      if (err) console.error('Error creating bids table', err);
    });
  });
}

initDb();

// Helper: run query with params, return Promise
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Example route: get auction status
app.get('/auction/status', async (req, res) => {
  try {
    const { product_id } = req.query;
    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const auction = await getAsync(
      'SELECT * FROM auctions WHERE product_id = ?',
      [product_id]
    );

    if (!auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    const bids = await allAsync(
      'SELECT * FROM bids WHERE product_id = ? ORDER BY amount DESC',
      [product_id]
    );

    res.json({
      auction,
      bids,
    });
  } catch (err) {
    console.error('Error in /auction/status', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Example route: place bid
app.post('/auction/bid', async (req, res) => {
  try {
    const { product_id, email, display_name, amount } = req.body;
    if (!product_id || !email || !display_name || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const now = new Date().toISOString();

    await runAsync(
      `INSERT INTO bids (product_id, email, display_name, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [product_id, email, display_name, amount, now]
    );

    // Update highest bid in auctions table
    const current = await getAsync(
      'SELECT highest_bid_amount FROM auctions WHERE product_id = ?',
      [product_id]
    );

    if (!current || amount > (current.highest_bid_amount || 0)) {
      await runAsync(
        `INSERT INTO auctions (
           product_id, end_time, highest_bid_amount,
           highest_bidder_name, highest_bidder_email, updated_at
         )
         VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           highest_bid_amount = excluded.highest_bid_amount,
           highest_bidder_name = excluded.highest_bidder_name,
           highest_bidder_email = excluded.highest_bidder_email,
           updated_at = excluded.updated_at`,
        [product_id, amount, display_name, email, now]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error in /auction/bid', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Auction backend running');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
