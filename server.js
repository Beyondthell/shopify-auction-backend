const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const nodemailer = require('nodemailer');

// CONFIG
const PORT = process.env.PORT || 4000;
const PUBLIC_KEY = process.env.AUCTION_PUBLIC_KEY || 'PUBLIC_KEY_FROM_BACKEND';
const ADMIN_SECRET = process.env.AUCTION_ADMIN_SECRET || 'REPLACE_WITH_STRONG_SECRET';

// Email config
const EMAIL_FROM = process.env.AUCTION_EMAIL_FROM || 'no-reply@example.com';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.example.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || 'user';
const SMTP_PASS = process.env.SMTP_PASS || 'password';

let db;

async function initDb() {
  db = await open({
    filename: './auction.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS auctions (
      product_id TEXT PRIMARY KEY,
      end_time TEXT,
      highest_bid_amount REAL,
      highest_bidder_name TEXT,
      highest_bidder_email TEXT,
      updated_at TEXT,
      winner_notified_at TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Simple public-key middleware
app.use((req, res, next) => {
  // Skip for admin endpoints
  if (req.path.startsWith('/auction/admin')) {
    return next();
  }
  const key = req.header('X-Auction-Public-Key');
  if (!key || key !== PUBLIC_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
});

// Utility
function nowISO() {
  return new Date().toISOString();
}

async function getAuction(productId) {
  const row = await db.get('SELECT * FROM auctions WHERE product_id = ?', productId);
  return row || null;
}

async function upsertAuction(auction) {
  const existing = await getAuction(auction.product_id);
  if (existing) {
    await db.run(
      `UPDATE auctions SET
        end_time = COALESCE(?, end_time),
        highest_bid_amount = COALESCE(?, highest_bid_amount),
        highest_bidder_name = COALESCE(?, highest_bidder_name),
        highest_bidder_email = COALESCE(?, highest_bidder_email),
        updated_at = ?
       WHERE product_id = ?`,
      auction.end_time || existing.end_time,
      auction.highest_bid_amount != null ? auction.highest_bid_amount : existing.highest_bid_amount,
      auction.highest_bidder_name || existing.highest_bidder_name,
      auction.highest_bidder_email || existing.highest_bidder_email,
      nowISO(),
      auction.product_id
    );
  } else {
    await db.run(
      `INSERT INTO auctions
        (product_id, end_time, highest_bid_amount, highest_bidder_name, highest_bidder_email, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      auction.product_id,
      auction.end_time || null,
      auction.highest_bid_amount != null ? auction.highest_bid_amount : null,
      auction.highest_bidder_name || null,
      auction.highest_bidder_email || null,
      nowISO()
    );
  }
}

// PUBLIC: get status
app.get('/auction/status', async (req, res) => {
  try {
    const productId = String(req.query.product_id || '');
    if (!productId) return res.status(400).json({ message: 'product_id required' });

    let auction = await getAuction(productId);
    if (!auction) {
      // Initialize empty auction row
      auction = {
        product_id: productId,
        end_time: null,
        highest_bid_amount: null,
        highest_bidder_name: null,
        highest_bidder_email: null,
        updated_at: null
      };
      await upsertAuction(auction);
      auction = await getAuction(productId);
    }

    const now = new Date();
    const endTime = auction.end_time ? new Date(auction.end_time) : null;
    const auctionEnded = endTime ? now >= endTime : false;

    res.json({
      productId,
      endTime: auction.end_time,
      highestBidAmount: auction.highest_bid_amount,
      highestBidderName: auction.highest_bidder_name,
      auctionEnded
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUBLIC: register email
app.post('/auction/register', async (req, res) => {
  try {
    const { product_id, email } = req.body;
    if (!product_id || !email) {
      return res.status(400).json({ message: 'product_id and email are required' });
    }
    // For now, just acknowledge; email is stored in bids table when bidding.
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUBLIC: place bid
app.post('/auction/bid', async (req, res) => {
  try {
    const { product_id, email, display_name, amount } = req.body;
    if (!product_id || !email || !display_name || typeof amount !== 'number') {
      return res.status(400).json({ message: 'Invalid payload' });
    }
    if (amount <= 0) {
      return res.status(400).json({ message: 'Bid amount must be positive' });
    }

    let auction = await getAuction(product_id);
    if (!auction) {
      auction = {
        product_id,
        end_time: null,
        highest_bid_amount: null,
        highest_bidder_name: null,
        highest_bidder_email: null
      };
      await upsertAuction(auction);
      auction = await getAuction(product_id);
    }

    const now = new Date();
    const endTime = auction.end_time ? new Date(auction.end_time) : null;
    const auctionEnded = endTime ? now >= endTime : false;
    if (auctionEnded) {
      return res.status(400).json({ message: 'Auction has ended' });
    }

    const currentHighest = auction.highest_bid_amount != null ? auction.highest_bid_amount : 0;
    if (amount <= currentHighest) {
      return res.status(400).json({ message: 'Bid must be higher than current highest bid' });
    }

    // Store bid
    await db.run(
      `INSERT INTO bids (product_id, email, display_name, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      product_id,
      email,
      display_name,
      amount,
      nowISO()
    );

    // Update auction
    await upsertAuction({
      product_id,
      highest_bid_amount: amount,
      highest_bidder_name: display_name,
      highest_bidder_email: email
    });

    const updated = await getAuction(product_id);
    const updatedEndTime = updated.end_time ? new Date(updated.end_time) : null;
    const updatedEnded = updatedEndTime ? now >= updatedEndTime : false;

    res.json({
      productId: product_id,
      endTime: updated.end_time,
      highestBidAmount: updated.highest_bid_amount,
      highestBidderName: updated.highest_bidder_name,
      auctionEnded: updatedEnded
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ADMIN auth middleware
function requireAdmin(req, res, next) {
  const header = req.header('X-Auction-Admin-Secret');
  if (!header || header !== ADMIN_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

// ADMIN: set auction end time
app.post('/auction/admin/set-end', requireAdmin, async (req, res) => {
  try {
    const { product_id, end_time } = req.body;
    if (!product_id || !end_time) {
      return res.status(400).json({ message: 'product_id and end_time required' });
    }
    const date = new Date(end_time);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ message: 'Invalid end_time' });
    }

    await upsertAuction({
      product_id,
      end_time: date.toISOString()
    });

    const updated = await getAuction(product_id);
    res.json({
      productId: product_id,
      endTime: updated.end_time
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ADMIN: reset bids
app.post('/auction/admin/reset', requireAdmin, async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) {
      return res.status(400).json({ message: 'product_id required' });
    }
    await db.run('DELETE FROM bids WHERE product_id = ?', product_id);
    await db.run(
      `UPDATE auctions
       SET highest_bid_amount = NULL,
           highest_bidder_name = NULL,
           highest_bidder_email = NULL,
           updated_at = ?
       WHERE product_id = ?`,
      nowISO(),
      product_id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ADMIN: get highest bid
app.get('/auction/admin/highest', requireAdmin, async (req, res) => {
  try {
    const productId = String(req.query.product_id || '');
    if (!productId) return res.status(400).json({ message: 'product_id required' });

    const auction = await getAuction(productId);
    if (!auction) return res.json({ productId, highestBidAmount: null, highestBidderName: null });

    res.json({
      productId,
      highestBidAmount: auction.highest_bid_amount,
      highestBidderName: auction.highest_bidder_name,
      highestBidderEmail: auction.highest_bidder_email,
      endTime: auction.end_time
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Email transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

// ADMIN: send winner email
app.post('/auction/admin/send-winner-email', requireAdmin, async (req, res) => {
  try {
    const { product_id, product_title, product_image_url, checkout_url, currency } = req.body;
    if (!product_id) {
      return res.status(400).json({ message: 'product_id required' });
    }

    const auction = await getAuction(product_id);
    if (!auction || auction.highest_bid_amount == null || !auction.highest_bidder_email) {
      return res.status(400).json({ message: 'No winner for this auction' });
    }

    const to = auction.highest_bidder_email;
    const name = auction.highest_bidder_name || 'Bidder';
    const amount = auction.highest_bid_amount;

    const subject = `You won the auction for ${product_title || 'our product'}`;
    const html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333;">
        <h2>Congratulations, ${name}!</h2>
        <p>You are the highest bidder for <strong>${product_title || 'the product'}</strong>.</p>
        <p>Your winning bid: <strong>${currency || ''} ${amount.toFixed(2)}</strong></p>
        ${product_image_url ? `<p><img src="${product_image_url}" alt="${product_title || 'Product'}" style="max-width: 300px;"></p>` : ''}
        ${checkout_url ? `<p><a href="${checkout_url}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;text-decoration:none;">Complete Your Purchase</a></p>` : ''}
        <p>If you have any questions, reply to this email.</p>
      </div>
    `;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      html
    });

    await db.run(
      'UPDATE auctions SET winner_notified_at = ? WHERE product_id = ?',
      nowISO(),
      product_id
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log('Auction backend running on port', PORT);
  });
}).catch(err => {
  console.error('Failed to init DB', err);
});
