const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const CLIENT_URL = process.env.CLIENT_URL || "*";
app.use(cors({ origin: CLIENT_URL }));
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

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "pussy", "porn", "slut", "whore"];
const BAD_RE = new RegExp("\\b(" + BAD_WORDS.join("|") + ")\\w*", "gi");
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|co|in|ru|xyz|ly)\b)/i;

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

function broadcastCount() {
  io.emit("online", io.engine.clientsCount);
}

function compatible(a, b) {
  const aOk = a.wantCountry === "Any" || a.wantCountry === b.country;
  const bOk = b.wantCountry === "Any" || b.wantCountry === a.country;
  return aOk && bOk;
}

function removeFromQueue(id) {
  const i = waiting.findIndex((w) => w.socket.id === id);
  if (i !== -1) waiting.splice(i, 1);
}

function pair(a, b) {
  partners.set(a.socket.id, b.socket);
  partners.set(b.socket.id, a.socket);
  const entries = [];
  chatLogs.set(a.socket.id, { entries, side: "A" });
  chatLogs.set(b.socket.id, { entries, side: "B" });
  a.socket.emit("matched", { country: b.country });
  b.socket.emit("matched", { country: a.country });
}

function findMatch(me) {
  const idx = waiting.findIndex((w) => compatible(me, w));
  if (idx === -1) {
    waiting.push(me);
    me.socket.emit("waiting");
    return;
  }
  const other = waiting.splice(idx, 1)[0];
  pair(me, other);
}

function leave(socket) {
  removeFromQueue(socket.id);
  chatLogs.delete(socket.id);
  const partner = partners.get(socket.id);
  if (partner) {
    partners.delete(socket.id);
    partners.delete(partner.id);
    chatLogs.delete(partner.id);
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
    const me = {
      socket,
      country: String((data && data.country) || "Unknown").slice(0, 60),
      wantCountry: String((data && data.wantCountry) || "Any").slice(0, 60),
    };
    profiles.set(socket.id, me);
    findMatch(me);
  });

  socket.on("relax", () => {
    const me = profiles.get(socket.id);
    if (!me || partners.has(socket.id)) return;
    removeFromQueue(socket.id);
    me.wantCountry = "Any";
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
