import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { COUNTRY_CODES } from "./countries.js";
import { LANGUAGE_CODES, TAGS } from "./languages.js";
import "./safety.css";
import "./profile.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|co|in|ru|xyz|ly)\b)/i;
const REPORT_REASONS = ["Spam", "Harassment or hate", "Sexual content", "Other"];

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

function languageName(code) {
  try {
    return languageNames.of(code) || code;
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

function profileLine(info) {
  const parts = [info.role === "local" ? "Lives there" : "Traveling"];
  if (info.languages && info.languages.length) {
    parts.push(info.languages.map(languageName).join(", "));
  }
  if (info.tags && info.tags.length) {
    parts.push(info.tags.map((t) => "#" + t.replace(/ /g, "")).join(" "));
  }
  return parts.join(" · ");
}

export default function App() {
  const socketRef = useRef(null);
  const typingTimer = useRef(null);
  const noticeTimer = useRef(null);
  const bottomRef = useRef(null);
  const sentTimes = useRef([]);
  const lastSent = useRef("");

  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(0);
  const [adult, setAdult] = useState(false);
  const [country, setCountry] = useState("");
  const [want, setWant] = useState("Any");
  const [role, setRole] = useState("traveler");
  const [wantRole, setWantRole] = useState("Any");
  const [languages, setLanguages] = useState([]);
  const [tags, setTags] = useState([]);
  const [screen, setScreen] = useState("home");
  const [status, setStatus] = useState("waiting");
  const [info, setInfo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [strangerTyping, setStrangerTyping] = useState(false);
  const [showRelax, setShowRelax] = useState(false);
  const [notice, setNotice] = useState("");
  const [banned, setBanned] = useState(false);
  const [reporting, setReporting] = useState(false);

  function showNotice(msg) {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
  }

  function toggle(list, setList, item, max) {
    if (list.includes(item)) setList(list.filter((x) => x !== item));
    else if (list.length < max) setList([...list, item]);
  }

  function joinPayload() {
    return { country, wantCountry: want, role, wantRole, languages, tags };
  }

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => {
      if (err && err.message === "banned") setBanned(true);
    });
    socket.on("banned", () => setBanned(true));
    socket.on("notice", (m) => showNotice(m));
    socket.on("online", (n) => setOnline(n));
    socket.on("waiting", () => {
      setStatus("waiting");
      setInfo(null);
    });
    socket.on("matched", (d) => {
      setStatus("chatting");
      setInfo(d);
      setShowRelax(false);
      setReporting(false);
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
      setReporting(false);
      setMessages((list) => [
        ...list,
        { system: true, text: "Stranger disconnected." },
      ]);
    });
    socket.on("reported", () => {
      setStatus("left");
      setStrangerTyping(false);
      setMessages((list) => [
        ...list,
        {
          system: true,
          text: "Report sent. You have been disconnected from this stranger.",
        },
      ]);
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    const anyone = want === "Any" && wantRole === "Any";
    if (screen !== "chat" || status !== "waiting" || anyone) {
      setShowRelax(false);
      return;
    }
    const t = setTimeout(() => setShowRelax(true), 30000);
    return () => clearTimeout(t);
  }, [screen, status, want, wantRole]);

  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages, strangerTyping]);

  function start() {
    setMessages([]);
    setStrangerTyping(false);
    setInfo(null);
    setStatus("waiting");
    setScreen("chat");
    socketRef.current.emit("join", joinPayload());
  }

  function next() {
    setMessages([]);
    setStrangerTyping(false);
    setReporting(false);
    setStatus("waiting");
    setInfo(null);
    socketRef.current.emit("join", joinPayload());
  }

  function stop() {
    socketRef.current.emit("leave");
    setMessages([]);
    setReporting(false);
    setInfo(null);
    setStatus("waiting");
    setScreen("home");
  }

  function relax() {
    socketRef.current.emit("relax");
    setWant("Any");
    setWantRole("Any");
    setShowRelax(false);
  }

  function doReport(reason) {
    socketRef.current.emit("report", reason);
    setReporting(false);
  }

  function send() {
    const t = text.trim();
    if (!t || status !== "chatting") return;
    if (URL_RE.test(t)) {
      showNotice("Links and email addresses aren't allowed in chat.");
      return;
    }
    if (lastSent.current === t.toLowerCase()) {
      showNotice("Please don't repeat the same message.");
      return;
    }
    const now = Date.now();
    sentTimes.current = sentTimes.current.filter((x) => now - x < 5000);
    if (sentTimes.current.length >= 5) {
      showNotice("You're sending messages too fast. Slow down.");
      return;
    }
    sentTimes.current.push(now);
    lastSent.current = t.toLowerCase();
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

  if (banned) {
    return (
      <div className="page">
        <div className="card">
          <h1>Temporarily banned</h1>
          <p className="sub">
            Several users reported you, so you can't use Travel Chat for 24
            hours.
          </p>
        </div>
      </div>
    );
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

          <label>I am</label>
          <div className="role-row">
            <button
              className={"chip" + (role === "traveler" ? " on" : "")}
              onClick={() => setRole("traveler")}
            >
              ✈️ Traveling
            </button>
            <button
              className={"chip" + (role === "local" ? " on" : "")}
              onClick={() => setRole("local")}
            >
              🏠 I live here
            </button>
          </div>

          <label>Languages you speak ({languages.length}/5)</label>
          <div className="chips lang-box">
            {LANGUAGE_CODES.map((code) => (
              <button
                key={code}
                className={"chip" + (languages.includes(code) ? " on" : "")}
                onClick={() => toggle(languages, setLanguages, code, 5)}
              >
                {languageName(code)}
              </button>
            ))}
          </div>

          <label>Trip tags, optional ({tags.length}/4)</label>
          <div className="chips">
            {TAGS.map((tag) => (
              <button
                key={tag}
                className={"chip" + (tags.includes(tag) ? " on" : "")}
                onClick={() => toggle(tags, setTags, tag, 4)}
              >
                {tag}
              </button>
            ))}
          </div>

          <label>Who do you want to meet?</label>
          <select value={want} onChange={(e) => setWant(e.target.value)}>
            <option value="Any">Any country</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {flag(c.code)} {c.name}
              </option>
            ))}
          </select>
          <select value={wantRole} onChange={(e) => setWantRole(e.target.value)}>
            <option value="Any">Travelers and locals</option>
            <option value="traveler">Only travelers</option>
            <option value="local">Only locals</option>
          </select>
          <p className="hint">
            We try to match people who share a language first, then trip tags.
          </p>

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
            or address. Users who are reported can be banned.
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
        <div className="header-left">
          <span>{info ? label(info.country) : "Looking for a stranger…"}</span>
          {info && <div className="profile-line">{profileLine(info)}</div>}
        </div>
        <div className="header-right">
          <small>{online} online</small>
          {status === "chatting" && (
            <button className="report-btn" onClick={() => setReporting(true)}>
              Report
            </button>
          )}
        </div>
      </header>
      <div className="safety-banner">
        Never share your hotel, address, or passport details.
      </div>

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

      {notice && <div className="toast">{notice}</div>}

      {reporting && (
        <div className="report-panel">
          <div>Report this stranger for:</div>
          <div className="report-options">
            {REPORT_REASONS.map((r) => (
              <button key={r} className="ghost" onClick={() => doReport(r)}>
                {r}
              </button>
            ))}
          </div>
          <button className="link" onClick={() => setReporting(false)}>
            Cancel
          </button>
        </div>
      )}

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
