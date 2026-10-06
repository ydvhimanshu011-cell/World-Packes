const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const CLIENT_URL = process.env.CLIENT_URL || "*";
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: "10kb" }));
app.get("/", (req, res) => res.send("Travel chat server is running"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CLIENT_URL } });

const waiting = [];
const partners = new Map();
const profiles = new Map();
const chatLogs = new Map();

const bans = new Map();
const reportsAgainst = new Map();
const BAN_MS = 24 * 60 * 60 * 1000;
const REPORTS_TO_BAN = 3;

const ROLES = ["traveler", "local"];
const TAGS = ["backpacking", "food", "budget", "solo", "study abroad", "business"];
const HANDLE_RE = /^[A-Za-z0-9._@+\- ]{2,40}$/;

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "pussy", "porn", "slut", "whore"];
const BAD_RE = new RegExp("\\b(" + BAD_WORDS.join("|") + ")\\w*", "gi");
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|co|in|ru|xyz|ly)\b)/i;

// ---------- Translation (Google Cloud Translation, key stays on the server) ----------
const translateCache = new Map();
const translateIpHits = new Map();
const translateIpDay = new Map();
const translateDaily = { day: "", chars: 0 };
const IP_PER_MIN = 30;
const IP_PER_DAY = 300;
const DAILY_CHAR_CAP = 200000;

function reqIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

app.post("/api/translate", async (req, res) => {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) return res.status(503).json({ error: "Translation is not set up yet." });

  const text = String((req.body && req.body.text) || "").trim();
  const target = String((req.body && req.body.targetLang) || "en");
  if (!text || text.length > 500) {
    return res.status(400).json({ error: "Message is empty or too long." });
  }
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(target)) {
    return res.status(400).json({ error: "Unsupported language." });
  }

  const cacheKey = target + "|" + text;
  if (translateCache.has(cacheKey)) {
    return res.json({ translated: translateCache.get(cacheKey) });
  }

  const ip = reqIp(req);
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const hits = (translateIpHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= IP_PER_MIN) {
    return res.status(429).json({ error: "Too many translations. Wait a moment." });
  }
  const dayInfo = translateIpDay.get(ip);
  const dayCount = dayInfo && dayInfo.day === today ? dayInfo.count : 0;
  if (dayCount >= IP_PER_DAY) {
    return res.status(429).json({ error: "Daily translation limit reached." });
  }
  if (translateDaily.day !== today) {
    translateDaily.day = today;
    translateDaily.chars = 0;
  }
  if (translateDaily.chars + text.length > DAILY_CHAR_CAP) {
    return res.status(429).json({ error: "Translation is paused for today." });
  }

  hits.push(now);
  translateIpHits.set(ip, hits);
  translateIpDay.set(ip, { day: today, count: dayCount + 1 });
  translateDaily.chars += text.length;

  try {
    const r = await fetch(
      "https://translation.googleapis.com/language/translate/v2?key=" + encodeURIComponent(key),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, target, format: "text" }),
      }
    );
    const data = await r.json();
    if (!r.ok || !data.data) {
      console.log("TRANSLATE ERROR " + r.status + " " + JSON.stringify((data && data.error && data.error.message) || ""));
      return res.status(502).json({ error: "Translation failed." });
    }
    const translated = data.data.translations[0].translatedText;
    if (translateCache.size > 500) translateCache.clear();
    translateCache.set(cacheKey, translated);
    res.json({ translated });
  } catch (e) {
    console.log("TRANSLATE ERROR " + e.message);
    res.status(502).json({ error: "Translation failed." });
  }
});

// ---------- Chat helpers ----------
function getIp(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return socket.handshake.address;
}

function isBanned(ip) {
  const until = bans.get(ip);
  if (!until) return false;
  if (until > Date.now()) return true;
  bans.delete(ip);
  return false;
}

function allow(socket, key, max, windowMs) {
  const now = Date.now();
  if (!socket.data.rate) socket.data.rate = {};
  const list = (socket.data.rate[key] || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    socket.data.rate[key] = list;
    return false;
  }
  list.push(now);
  socket.data.rate[key] = list;
  return true;
}

function cleanList(list, max, allowed) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const v = String(item).slice(0, 30);
    if (allowed && !allowed.includes(v)) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function broadcastCount() {
  io.emit("online", io.engine.clientsCount);
}

function compatible(a, b) {
  const countryOk =
    (a.wantCountry === "Any" || a.wantCountry === b.country) &&
    (b.wantCountry === "Any" || b.wantCountry === a.country);
  const roleOk =
    (a.wantRole === "Any" || a.wantRole === b.role) &&
    (b.wantRole === "Any" || b.wantRole === a.role);
  return countryOk && roleOk;
}

function score(a, b) {
  const langs = a.languages.filter((l) => b.languages.includes(l)).length;
  const tags = a.tags.filter((t) => b.tags.includes(t)).length;
  return langs * 10 + tags;
}

function publicProfile(p) {
  return { country: p.country, role: p.role, languages: p.languages, tags: p.tags };
}

function removeFromQueue(id) {
  const i = waiting.findIndex((w) => w.socket.id === id);
  if (i !== -1) waiting.splice(i, 1);
}

function pair(a, b) {
  partners.set(a.socket.id, b.socket);
  partners.set(b.socket.id, a.socket);
  a.socket.data.contact = null;
  b.socket.data.contact = null;
  const entries = [];
  chatLogs.set(a.socket.id, { entries, side: "A" });
  chatLogs.set(b.socket.id, { entries, side: "B" });
  a.socket.emit("matched", publicProfile(b));
  b.socket.emit("matched", publicProfile(a));
}

function findMatch(me) {
  let best = -1;
  let bestScore = -1;
  waiting.forEach((w, i) => {
    if (!compatible(me, w)) return;
    const s = score(me, w);
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  });
  if (best === -1) {
    waiting.push(me);
    me.socket.emit("waiting");
    return;
  }
  const other = waiting.splice(best, 1)[0];
  pair(me, other);
}

function leave(socket) {
  removeFromQueue(socket.id);
  chatLogs.delete(socket.id);
  socket.data.contact = null;
  const partner = partners.get(socket.id);
  if (partner) {
    partners.delete(socket.id);
    partners.delete(partner.id);
    chatLogs.delete(partner.id);
    partner.data.contact = null;
    partner.emit("partner_left");
  }
}

io.use((socket, next) => {
  if (isBanned(getIp(socket))) return next(new Error("banned"));
  next();
});

io.on("connection", (socket) => {
  broadcastCount();

  socket.on("join", (data) => {
    if (isBanned(getIp(socket))) {
      socket.emit("banned");
      socket.disconnect(true);
      return;
    }
    if (!allow(socket, "join", 10, 60000)) {
      socket.emit("notice", "Too many skips. Wait a moment and try again.");
      return;
    }
    leave(socket);
    const d = data || {};
    const me = {
      socket,
      country: String(d.country || "Unknown").slice(0, 60),
      wantCountry: String(d.wantCountry || "Any").slice(0, 60),
      role: ROLES.includes(d.role) ? d.role : "traveler",
      wantRole: ROLES.includes(d.wantRole) ? d.wantRole : "Any",
      languages: cleanList(d.languages, 5).filter((l) => /^[a-z]{2,3}$/.test(l)),
      tags: cleanList(d.tags, 4, TAGS),
    };
    profiles.set(socket.id, me);
    findMatch(me);
  });

  socket.on("relax", () => {
    const me = profiles.get(socket.id);
    if (!me || partners.has(socket.id)) return;
    removeFromQueue(socket.id);
    me.wantCountry = "Any";
    me.wantRole = "Any";
    findMatch(me);
  });

  socket.on("message", (text) => {
    const partner = partners.get(socket.id);
    if (!partner) return;
    if (!allow(socket, "msg", 5, 5000)) {
      socket.emit("notice", "You're sending messages too fast. Slow down.");
      return;
    }
    let clean = String(text || "").trim().slice(0, 1000);
    if (!clean) return;
    if (URL_RE.test(clean)) {
      socket.emit("notice", "Links and email addresses aren't allowed in chat.");
      return;
    }
    if (socket.data.lastMsg === clean.toLowerCase()) {
      socket.emit("notice", "Please don't repeat the same message.");
      return;
    }
    socket.data.lastMsg = clean.toLowerCase();
    clean = clean.replace(BAD_RE, "***");
    const log = chatLogs.get(socket.id);
    if (log) {
      log.entries.push({ by: log.side, text: clean });
      if (log.entries.length > 10) log.entries.shift();
    }
    partner.emit("message", clean);
  });

  socket.on("typing", (isTyping) => {
    if (!allow(socket, "typing", 20, 5000)) return;
    const partner = partners.get(socket.id);
    if (partner) partner.emit("typing", !!isTyping);
  });

  socket.on("share_contact", (handle) => {
    const partner = partners.get(socket.id);
    if (!partner) return;
    if (!allow(socket, "contact", 5, 60000)) return;
    if (socket.data.contact) return;
    const h = String(handle || "").trim();
    if (!HANDLE_RE.test(h)) {
      socket.emit("notice", "That doesn't look right. Use a username or phone number.");
      return;
    }
    socket.data.contact = h;
    if (partner.data.contact) {
      socket.emit("contact_revealed", { handle: partner.data.contact });
      partner.emit("contact_revealed", { handle: socket.data.contact });
    } else {
      partner.emit("contact_offer");
    }
  });

  socket.on("report", (reason) => {
    const partner = partners.get(socket.id);
    if (!partner) return;
    if (!allow(socket, "report", 3, 60000)) return;
    const log = chatLogs.get(socket.id);
    const reporterIp = getIp(socket);
    const reportedIp = getIp(partner);
    console.log(
      "REPORT " +
        JSON.stringify({
          at: new Date().toISOString(),
          reason: String(reason || "").slice(0, 100),
          reportedSide: log ? (log.side === "A" ? "B" : "A") : "unknown",
          lastMessages: log ? log.entries : [],
        })
    );
    leave(socket);
    if (reporterIp !== reportedIp) {
      const set = reportsAgainst.get(reportedIp) || new Set();
      set.add(reporterIp);
      reportsAgainst.set(reportedIp, set);
      if (set.size >= REPORTS_TO_BAN) {
        bans.set(reportedIp, Date.now() + BAN_MS);
        reportsAgainst.delete(reportedIp);
        partner.emit("banned");
        partner.disconnect(true);
      }
    }
    socket.emit("reported");
  });

  socket.on("leave", () => leave(socket));

  socket.on("disconnect", () => {
    leave(socket);
    profiles.delete(socket.id);
    broadcastCount();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, until] of bans) {
    if (until <= now) bans.delete(ip);
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
