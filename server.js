import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || "./auth_info");
const CONTACTS_FILE = path.join(AUTH_DIR, "contacts.json");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

fs.mkdirSync(AUTH_DIR, { recursive: true });

app.set("trust proxy", 1);
app.use(cors());

// Optional Basic Auth lock when APP_PASSWORD is set in .env
app.use((req, res, next) => {
  if (!APP_PASSWORD || req.path === "/health" || req.path === "/qr") {
    return next();
  }
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const pass = decoded.split(":").slice(1).join(":");
    if (pass === APP_PASSWORD) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="WA DP Downloader"');
  return res.status(401).send("Authentication required");
});

app.use(express.static("public"));

const dpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute." },
});

let sock = null;
let isConnected = false;
let latestQr = null;

// Short-lived DP URL cache (5 mins)
const dpCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dpCache.entries()) {
    if (v.expiresAt <= now) dpCache.delete(k);
  }
}, 60 * 1000).unref();

// Synced WhatsApp contacts store
const contactsMap = new Map();
try {
  if (fs.existsSync(CONTACTS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8"));
    for (const item of saved) {
      if (item?.phone) contactsMap.set(item.phone, item);
    }
  }
} catch {
  // Start fresh if contacts.json is unreadable
}

let saveTimer = null;
function scheduleSaveContacts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(
        CONTACTS_FILE,
        JSON.stringify(Array.from(contactsMap.values()), null, 2)
      );
    } catch (err) {
      console.error("Failed to save contacts:", err.message);
    }
  }, 1000);
}

function upsertContacts(list = []) {
  let changed = false;
  for (const c of list) {
    if (!c?.id || !c.id.endsWith("@s.whatsapp.net")) continue;
    const phone = c.id.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (phone.length < 7) continue;

    const incomingName = (c.name || c.notify || c.verifiedName || "").trim();
    const existing = contactsMap.get(phone);
    const bestName = incomingName || existing?.name || "";

    if (!existing || (bestName && existing.name !== bestName)) {
      contactsMap.set(phone, { phone, name: bestName });
      changed = true;
    }
  }
  if (changed) scheduleSaveContacts();
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ contacts }) => {
    if (Array.isArray(contacts)) upsertContacts(contacts);
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    if (Array.isArray(contacts)) upsertContacts(contacts);
  });

  sock.ev.on("contacts.update", (contacts) => {
    if (Array.isArray(contacts)) upsertContacts(contacts);
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      console.log("\nScan this QR code in WhatsApp -> Linked Devices:");
      qrcodeTerminal.generate(qr, { small: true });
      if (ADMIN_KEY) {
        console.log(`Or open in browser: /qr?key=${ADMIN_KEY}`);
      }
    }

    if (connection === "open") {
      isConnected = true;
      latestQr = null;
      console.log("WhatsApp connected and ready!");
    } else if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Disconnected (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        latestQr = null;
        console.log("Logged out. Delete auth_info folder and restart to scan QR again.");
      }
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    whatsappConnected: isConnected,
    syncedContacts: contactsMap.size,
  });
});

app.get("/qr", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Forbidden: Set ADMIN_KEY in .env and pass ?key=YOUR_ADMIN_KEY");
  }

  if (isConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2 style="color:#008069;">WhatsApp is Connected</h2>
        <p>Synced contacts: ${contactsMap.size}</p>
        <p><a href="/">Open App</a></p>
      </body></html>
    `);
  }

  if (!latestQr) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;">
        <p>Generating QR code... refreshing automatically.</p>
      </body></html>
    `);
  }

  const qrDataUrl = await QRCode.toDataURL(latestQr, { width: 300, margin: 2 });
  return res.send(`
    <html><head><meta http-equiv="refresh" content="12"></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>Link Your WhatsApp</h2>
      <p>WhatsApp &rarr; <strong>Linked Devices</strong> &rarr; <strong>Link a Device</strong></p>
      <img src="${qrDataUrl}" alt="QR Code" style="border:1px solid #ddd;border-radius:12px;" />
      <p style="color:#666;font-size:13px;">Auto-refreshes every 12 seconds.</p>
    </body></html>
  `);
});

// List synced WhatsApp contacts
app.get("/api/contacts", (_req, res) => {
  const list = Array.from(contactsMap.values()).sort((a, b) =>
    (a.name || a.phone).localeCompare(b.name || b.phone)
  );
  res.json({ contacts: list });
});

// Fetch DP for a phone number
app.get("/api/dp", dpLimiter, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({
      error: "WhatsApp is not connected yet. Link your QR first.",
    });
  }

  const digits = String(req.query.phone || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return res.status(400).json({ error: "Invalid phone number." });
  }

  const cached = dpCache.get(digits);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ imageUrl: `/api/image?phone=${digits}` });
  }

  try {
    const [account] = await sock.onWhatsApp(digits);
    if (!account?.exists) {
      return res.status(404).json({ error: "Not registered on WhatsApp." });
    }

    const ppUrl = await sock.profilePictureUrl(account.jid, "image");
    dpCache.set(digits, { url: ppUrl, expiresAt: Date.now() + CACHE_TTL_MS });

    return res.json({ imageUrl: `/api/image?phone=${digits}` });
  } catch {
    return res.status(404).json({
      error: "Hidden by privacy settings or no DP set.",
    });
  }
});

// Same-origin image proxy for clean preview & download
app.get("/api/image", async (req, res) => {
  const digits = String(req.query.phone || "").replace(/\D/g, "");
  if (!/^\d{7,15}$/.test(digits)) {
    return res.status(400).send("Invalid phone");
  }

  const cached = dpCache.get(digits);
  if (!cached || cached.expiresAt <= Date.now()) {
    return res.status(404).send("Image expired. Search again.");
  }

  try {
    const upstream = await fetch(cached.url);
    if (!upstream.ok) return res.status(502).send("Upstream image error.");

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(buffer);
  } catch {
    return res.status(502).send("Failed to load image.");
  }
});

const server = app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`);
  connectToWhatsApp();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}