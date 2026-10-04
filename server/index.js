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
  const partner = partners.get(socket.id);
  if (partner) {
    partners.delete(socket.id);
    partners.delete(partner.id);
    partner.emit("partner_left");
  }
}

io.on("connection", (socket) => {
  broadcastCount();

  socket.on("join", (data) => {
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
    const clean = String(text || "").trim().slice(0, 1000);
    if (partner && clean) partner.emit("message", clean);
  });

  socket.on("typing", (isTyping) => {
    const partner = partners.get(socket.id);
    if (partner) partner.emit("typing", !!isTyping);
  });

  socket.on("leave", () => leave(socket));

  socket.on("disconnect", () => {
    leave(socket);
    profiles.delete(socket.id);
    broadcastCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
