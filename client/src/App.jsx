import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { COUNTRY_CODES } from "./countries.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function flag(code) {
  return code
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
    .join("");
}

function nameOf(code) {
  try {
    return regionNames.of(code) || code;
  } catch (e) {
    return code;
  }
}

const COUNTRIES = COUNTRY_CODES.map((code) => ({ code, name: nameOf(code) })).sort(
  (a, b) => a.name.localeCompare(b.name)
);

function label(code) {
  if (code === "Any") return "Any country";
  return flag(code) + " " + nameOf(code);
}

export default function App() {
  const socketRef = useRef(null);
  const typingTimer = useRef(null);
  const bottomRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(0);
  const [adult, setAdult] = useState(false);
  const [country, setCountry] = useState("");
  const [want, setWant] = useState("Any");
  const [screen, setScreen] = useState("home");
  const [status, setStatus] = useState("waiting");
  const [stranger, setStranger] = useState("");
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [strangerTyping, setStrangerTyping] = useState(false);
  const [showRelax, setShowRelax] = useState(false);

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("online", (n) => setOnline(n));
    socket.on("waiting", () => {
      setStatus("waiting");
      setStranger("");
    });
    socket.on("matched", (d) => {
      setStatus("chatting");
      setStranger(d.country);
      setShowRelax(false);
      setMessages([
        { system: true, text: "You are now chatting with a stranger. Say hi!" },
      ]);
    });
    socket.on("message", (m) => {
      setMessages((list) => [...list, { from: "them", text: m }]);
      setStrangerTyping(false);
    });
    socket.on("typing", (t) => setStrangerTyping(!!t));
    socket.on("partner_left", () => {
      setStatus("left");
      setStrangerTyping(false);
      setMessages((list) => [
        ...list,
        { system: true, text: "Stranger disconnected." },
      ]);
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (screen !== "chat" || status !== "waiting" || want === "Any") {
      setShowRelax(false);
      return;
    }
    const t = setTimeout(() => setShowRelax(true), 30000);
    return () => clearTimeout(t);
  }, [screen, status, want]);

  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages, strangerTyping]);

  function start() {
    setMessages([]);
    setStrangerTyping(false);
    setStatus("waiting");
    setScreen("chat");
    socketRef.current.emit("join", { country, wantCountry: want });
  }

  function next() {
    setMessages([]);
    setStrangerTyping(false);
    setStatus("waiting");
    setStranger("");
    socketRef.current.emit("join", { country, wantCountry: want });
  }

  function stop() {
    socketRef.current.emit("leave");
    setMessages([]);
    setStatus("waiting");
    setScreen("home");
  }

  function relax() {
    socketRef.current.emit("relax");
    setWant("Any");
    setShowRelax(false);
  }

  function send() {
    const t = text.trim();
    if (!t || status !== "chatting") return;
    socketRef.current.emit("message", t);
    socketRef.current.emit("typing", false);
    setMessages((list) => [...list, { from: "me", text: t }]);
    setText("");
  }

  function onType(e) {
    setText(e.target.value);
    if (status !== "chatting") return;
    socketRef.current.emit("typing", true);
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socketRef.current.emit("typing", false);
    }, 1500);
  }

  function onKey(e) {
    if (e.key === "Enter") send();
  }

  if (screen === "home") {
    return (
      <div className="page">
        <div className="card">
          <h1>🌍 Travel Chat</h1>
          <p className="sub">Meet travelers from around the world, one-on-one.</p>

          <label>Your country</label>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Select your country</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {flag(c.code)} {c.name}
              </option>
            ))}
          </select>

          <label>Who do you want to meet?</label>
          <select value={want} onChange={(e) => setWant(e.target.value)}>
            <option value="Any">Any country</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {flag(c.code)} {c.name}
              </option>
            ))}
          </select>

          <label className="check">
            <input
              type="checkbox"
              checked={adult}
              onChange={(e) => setAdult(e.target.checked)}
            />
            I confirm I am 18 or older
          </label>

          <p className="rules">
            Be kind. No hate, spam, or sharing personal details like your hotel
            or address.
          </p>

          <button disabled={!connected || !country || !adult} onClick={start}>
            {connected ? "Start Chat" : "Connecting… (first load can take 30 sec)"}
          </button>
          <p className="online">{online} online</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <header>
        <span>{stranger ? label(stranger) : "Looking for a stranger…"}</span>
        <small>{online} online</small>
      </header>

      <div className="messages">
        {status === "waiting" && (
          <div className="sys">Searching for someone to chat with…</div>
        )}
        {status === "waiting" && showRelax && (
          <button className="link" onClick={relax}>
            No match yet. Match with anyone instead
          </button>
        )}
        {messages.map((m, i) =>
          m.system ? (
            <div key={i} className="sys">
              {m.text}
            </div>
          ) : (
            <div key={i} className={"msg " + m.from}>
              {m.text}
            </div>
          )
        )}
        {strangerTyping && <div className="sys">Stranger is typing…</div>}
        <div ref={bottomRef} />
      </div>

      <div className="bar">
        <button className="ghost" onClick={stop}>
          Stop
        </button>
        <button className="ghost" onClick={next}>
          Next
        </button>
        <input
          type="text"
          value={text}
          placeholder={status === "chatting" ? "Type a message…" : "Waiting…"}
          disabled={status !== "chatting"}
          onChange={onType}
          onKeyDown={onKey}
        />
        <button onClick={send} disabled={status !== "chatting" || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
