// Лицензионное соглашение (EULA) при первом запуске клиентской сборки.
// Включается EULA_REQUIRED=true (задано в Dockerfile.dist; в разработке и тестах выключено).
// Пока администратор не принял соглашение, API отвечает 403 {code: "eula_required"} — кроме входа, справки
// и самого соглашения; токены CI не затрагиваются. Факт принятия — в app_settings (кто, когда, какая версия)
// и в журнале аудита. Новая редакция соглашения (EULA_VERSION) потребует принять его заново.
const fs = require("fs");
const path = require("path");
const express = require("express");
const { marked } = require("marked");
const { pool } = require("./db");
const audit = require("./audit");
const { wrap } = require("./util");

const EULA_VERSION = "2026-11";
const FILE = path.join(__dirname, "..", "LICENSE-EULA.md");
const required = () => process.env.EULA_REQUIRED === "true";

let cache = null;
async function state() {
  if (!required()) return { required: false, accepted: true };
  if (cache) return cache;
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='eula'").catch(() => ({ rows: [] }));
  let saved = null;
  try {
    saved = rows[0] ? JSON.parse(rows[0].value) : null;
  } catch {
    saved = null;
  }
  const accepted = !!saved && saved.version === EULA_VERSION;
  const value = { required: true, accepted, version: EULA_VERSION, acceptedBy: accepted ? saved.by : null, acceptedAt: accepted ? saved.at : null };
  // принятое запоминаем навсегда, непринятое — перепроверяем (могли принять с другой реплики)
  if (accepted) cache = value;
  return value;
}

// Что показать пользователю в /api/auth/me: "accept" — администратору принять, "wait" — остальным ждать
async function pendingFor(user) {
  const s = await state();
  if (s.accepted) return null;
  return user.role === "admin" ? "accept" : "wait";
}

const OPEN = /^\/api\/(auth\/.*|help(\/.*)?|eula(\/.*)?)$/;
function middleware() {
  return wrap(async (req, res, next) => {
    if (!required() || !req.user || req.viaToken || !req.path.startsWith("/api/") || OPEN.test(req.path)) return next();
    const s = await state();
    if (s.accepted) return next();
    res.status(403).json({ error: "Администратор должен принять лицензионное соглашение", code: "eula_required" });
  });
}

const router = express.Router();
router.get("/eula", wrap(async (_req, res) => {
  const s = await state();
  let text = "";
  try {
    text = marked.parse(fs.readFileSync(FILE, "utf8").replace(/<!--[\s\S]*?-->/g, ""));
  } catch {
    text = "<p>Текст соглашения не найден в поставке. Обратитесь к поставщику.</p>";
  }
  res.json({ ...s, html: text });
}));
router.post("/eula/accept", wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Войдите в систему" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Принять соглашение может только администратор" });
  if (!required()) return res.json({ ok: true });
  const value = { version: EULA_VERSION, by: req.user.login, name: req.user.name, at: new Date().toISOString() };
  await pool.query(
    "INSERT INTO app_settings(key, value) VALUES ('eula', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(value)]
  );
  cache = null;
  audit.log(req, "eula.accept", { project: null, target: EULA_VERSION });
  res.json({ ok: true });
}));

module.exports = { router, middleware, pendingFor, state, EULA_VERSION };
