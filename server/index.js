// журнал работы и метрики подключаются первыми: остальные модули уже при загрузке пишут в журнал и ходят в базу
const log = require("./log");
log.install();
const metrics = require("./metrics");
const jobs = require("./jobs");
const path = require("path");
const express = require("express");
const compression = require("compression");
const { pool, tx } = require("./db");
const { migrate, waitForDb } = require("./migrate");
const auth = require("./auth");
const access = require("./access");
const live = require("./live");
const attachments = require("./attachments");
const autotests = require("./autotests");
const folders = require("./folders");
const caseio = require("./caseio");
const seats = require("./seats");
const secrets = require("./secrets");
const plans = require("./plans");
const webhooks = require("./webhooks");
const trackers = require("./trackers");
const ci = require("./ci");
const projectio = require("./projectio");
const state = require("./state");
const lists = require("./lists");
const casemodel = require("./casemodel");
const audit = require("./audit");
const trash = require("./trash");
const { wrap, str, num, HttpError } = require("./util");
const { Limiter, MIN } = require("./limits");
const version = require("./version");
const security = require("./security");
const shared = require("./shared");
const review = require("./review");
const datasets = require("./datasets");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.LISTEN_HOST || "0.0.0.0";
const KEY_RE = /^[A-Z]{2,6}$/;
// closed — зарегистрироваться самому нельзя, учётные записи создаёт админ («Пользователи» → «Новый пользователь»)
const REGISTRATION = process.env.REGISTRATION === "open" ? "open" : "closed";
const RESERVED_ADMIN = (process.env.ADMIN_LOGIN || "").trim().toLowerCase();
// Даже если в данные попадёт скрипт, браузер выполнит только код самого приложения
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
// Токен может только отправлять результаты автотестов: создать запуск, прислать результаты и файлы, завершить запуск.
// Читать и удалять с ним нельзя ничего — даже утёкший токен не откроет данные и не сотрёт историю
const TOKEN_ROUTES = [
  ["POST", /^\/projects\/[^/]+\/autoruns$/],
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/results$/],
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/allure$/],
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/results\/\d+\/attachments$/],
  ["PATCH", /^\/projects\/[^/]+\/autoruns\/\d+$/],
  ["GET", /^\/projects\/[^/]+\/autoruns\/\d+\/summary$/],
];
const { broadcast } = live;

const app = express();
app.disable("x-powered-by");
// номер запроса, метрики и журнал запросов (server/metrics.js)
app.use(metrics.middleware());
// Версия API в пути: /api/v1/... — то же, что /api/... (текущая и единственная версия). Интеграциям лучше
// использовать /api/v1: при несовместимых изменениях появится /api/v2, а v1 продолжит работать
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/v1/") || req.url === "/api/v1") req.url = "/api" + req.url.slice(7);
  next();
});
// Сжатие ответов: состояние большого проекта в JSON сжимается в 10–15 раз. Поток живых обновлений не сжимаем — он должен
// приходить сразу, а не копиться в буфере
app.use(compression({ filter: (req, res) => !req.path.startsWith("/api/events") && compression.filter(req, res) }));
// За обратным прокси (Cloudflare Tunnel, Caddy, nginx) нужно доверять X-Forwarded-*, чтобы cookie получали флаг Secure
// TRUST_PROXY=false — никому (приложение открыто напрямую: иначе любой подделает свой IP и обойдёт лимиты входа)
const TRUST = (process.env.TRUST_PROXY || "").trim();
app.set("trust proxy", !TRUST ? "loopback, linklocal, uniquelocal" : TRUST === "false" ? false : TRUST === "true" ? true : /^\d+$/.test(TRUST) ? Number(TRUST) : TRUST);

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": CSP,
  });
  // браузер больше не откроет сайт по HTTP и не даст подменить соединение. Только для этого адреса, без поддоменов
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  next();
});

// Сначала — кто пришёл. Тело запроса разбирается после: без входа нельзя заставить сервер разбирать мегабайты JSON
app.use(auth.loadUser);
// журнал аудита для изменяющих запросов к пользователям, интеграциям, токенам, удалениям (server/audit.js)
app.use(audit.middleware());
// Пароль выдан админом или истёк, либо политика требует 2FA, а она не включена: пока пользователь этого не сделал,
// доступны только вход/выход, смена пароля, настройка 2FA и справка. Токены CI не затрагиваются
const PENDING_OK = /^\/api\/(auth\/(me|logout|password|2fa(\/.*)?|sessions(\/.*)?)|help(\/.*)?)$/;
app.use((req, res, next) => {
  const p = req.user?.pending;
  if (!p || req.viaToken || !req.path.startsWith("/api/") || PENDING_OK.test(req.path)) return next();
  res.status(403).json({ error: security.PENDING_TEXT[p], code: p === "password" ? "password_change_required" : "2fa_setup_required" });
});
// Результаты автотестов приходят пачками вместе со стектрейсами — им нужен лимит побольше
const attachmentUpload = (req) => req.method === "POST" && req.path.endsWith("/attachments") && req.get("x-upload") === "1";
const bigJson = express.json({ limit: "10mb" });
app.use("/api/projects/:key/autoruns", (req, res, next) => (req.user && !attachmentUpload(req) ? bigJson(req, res, next) : next()));
// импорт тест-кейсов — CSV на тысячи строк
// импорт из Excel присылает файл в base64 — до 15 МБ файла
const importJson = express.json({ limit: "25mb" });
app.use("/api/projects/:key/cases/import", (req, res, next) => (req.user ? importJson(req, res, next) : next()));
// импорт проекта целиком (с вложениями в base64) и миграция из других TMS
const projectJson = express.json({ limit: projectio.IMPORT_MAX_BYTES });
app.use("/api/projects-import", (req, res, next) => (req.user ? projectJson(req, res, next) : next()));
const json = express.json({ limit: "200kb" });
app.use((req, res, next) => attachmentUpload(req) ? next() : json(req, res, next));

// Защита от CSRF: изменяющие запросы принимаются только как JSON.
// Загрузка файла идёт «сырым» телом, поэтому требует заголовок X-Upload: чужой сайт не может
// прислать его без CORS-разрешения, которого сервер не даёт.
app.use("/api", (req, res, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && !req.is("application/json")) {
    if (!attachmentUpload(req)) return res.status(415).json({ error: "Ожидается Content-Type: application/json" });
  }
  next();
});
// Токен (Authorization: Bearer) — со своими правами (scopes):
//   results — только отправка результатов автотестов (TOKEN_ROUTES), read — любые GET, write — изменения в проектах.
// Права владельца проверяются как обычно: write-токен наблюдателя ничего не изменит. Управление пользователями,
// токенами и входом по токену недоступно никогда. Лимит — TOKEN_RATE_LIMIT запросов в минуту на токен
const tokenLimit = new Limiter(Number(process.env.TOKEN_RATE_LIMIT || 600), MIN);
const NEVER_BY_TOKEN = /^\/(admin|tokens|auth|events)(\/|$)/;
app.use("/api", (req, res, next) => {
  if (!req.viaToken) return next();
  if (!tokenLimit.take(String(req.tokenId))) return res.status(429).json({ error: "Слишком много запросов с этим токеном. Подождите минуту" });
  const scopes = req.tokenScopes || ["results"];
  const isResults = TOKEN_ROUTES.some(([method, re]) => method === req.method && re.test(req.path));
  const ok = !NEVER_BY_TOKEN.test(req.path) && (
    (isResults && (scopes.includes("results") || scopes.includes("write")))
    || (req.method === "GET" && scopes.includes("read"))
    || (req.method !== "GET" && scopes.includes("write"))
  );
  if (!ok) {
    return res.status(403).json({
      error: scopes.length === 1 && scopes[0] === "results"
        ? "Токен подходит только для отправки результатов автотестов"
        : `У токена нет права на этот запрос (права токена: ${scopes.join(", ")})`,
    });
  }
  next();
});

app.get("/api/events", auth.requireUser, live.events);

// ---------- авторизация ----------
const me = (u) => ({ login: u.login, name: u.name, role: u.role, provider: u.auth_provider || "local", version: version.VERSION, pending: u.pending || null, passwordPolicy: security.policyText() });
// Администратор видит предупреждения о лицензии (истекает, истекла, ключ не принят) в шапке
const { limits, TOO_MANY } = auth;

// Политика обработки персональных данных (152-ФЗ): ссылка на странице входа, согласие при регистрации
const PRIVACY_URL = /^https?:\/\//.test(process.env.PRIVACY_POLICY_URL || "") ? process.env.PRIVACY_POLICY_URL : "";

// Что пользователь обязан сделать до начала работы (server/security.js)
async function pendingOf(userId) {
  const { rows } = await pool.query(
    "SELECT role, auth_provider, must_change_password, password_changed_at, totp_secret IS NOT NULL AS totp_enabled FROM users WHERE id=$1", [userId]
  );
  return rows[0] ? security.pendingAction(rows[0]) : null;
}

// Без входа — ещё и что показывать на странице входа: нужен ли код установки, открыта ли регистрация
app.get("/api/auth/me", wrap(async (req, res) => {
  if (req.user) {
    const { rows } = await pool.query("SELECT auth_provider FROM users WHERE id=$1", [req.user.id]);
    const user = me({ ...req.user, auth_provider: rows[0]?.auth_provider });
    user.twoFactor = !!req.user.totpEnabled;
    return res.json({ user });
  }
  res.json({ user: null, setup: await auth.needsSetup(), registration: REGISTRATION, providers: { local: true, ldap: false, oidc: null, kerberos: null }, passwordPolicy: security.policyText(), privacyPolicyUrl: PRIVACY_URL || null });
}));

app.post("/api/auth/register", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const name = str(req.body.name, 100);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const bad = auth.checkLogin(login) || (!name && "Укажите имя") || auth.checkPassword(password, { login, name });
  if (bad) return res.status(400).json({ error: bad });
  // лимит до проверки кода установки — иначе его можно подбирать
  if (!limits.registerIp.take(req.ip) || !limits.registerAll.take("all")) return res.status(429).json({ error: TOO_MANY });
  const setup = await auth.needsSetup();
  if (setup) await auth.prepareSetup(); // база могла опустеть после запуска сервера
  if (setup && !auth.checkSetupCode(req.body.setupCode)) {
    return res.status(403).json({ error: "Неверный код установки. Он напечатан в логах сервера" });
  }
  if (!setup && REGISTRATION === "closed") return res.status(403).json({ error: "Регистрация закрыта. Попросите администратора создать вам учётную запись" });
  // логин из ADMIN_LOGIN станет админом при перезапуске — занять его регистрацией нельзя
  if (!setup && login === RESERVED_ADMIN) return res.status(403).json({ error: "Этот логин зарезервирован. Выберите другой" });
  // 152-ФЗ: если задана политика обработки персональных данных, без согласия зарегистрироваться нельзя
  if (PRIVACY_URL && req.body.consent !== true) return res.status(400).json({ error: "Подтвердите согласие на обработку персональных данных" });
  const hash = await auth.hashPassword(password);
  // новичок только смотрит и не видит ни одного проекта, пока админ не выдаст доступ;
  // первый пользователь в пустой базе становится админом
  const { rows } = await pool.query(
    `INSERT INTO users(login, name, password_hash, role, pd_consent_at)
     VALUES ($1,$2,$3, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'developer' ELSE 'admin' END, CASE WHEN $4 THEN now() END)
     ON CONFLICT (login) DO NOTHING RETURNING id, role`,
    [login, name, hash, req.body.consent === true]
  );
  if (!rows[0]) return res.status(409).json({ error: "Логин уже занят. Выберите другой или войдите" });
  if (rows[0].role === "admin") auth.setupDone();
  await auth.createSession(res, req, rows[0].id);
  const pending = await pendingOf(rows[0].id);
  audit.log(req, "auth.register", { actor: { id: rows[0].id, login }, project: null, target: login, details: { role: rows[0].role } });
  broadcast("users");
  const user = me({ login, name, role: rows[0].role, pending });
  res.status(201).json({ user });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const key = `${req.ip}|${login}`;
  if (limits.loginIpLogin.blocked(key) || limits.loginIp.blocked(req.ip) || limits.loginAny.blocked(login)) {
    return res.status(429).json({ error: TOO_MANY });
  }
  const { rows } = await pool.query("SELECT id, login, name, role, blocked, password_hash, auth_provider FROM users WHERE login=$1", [login]);
  const u = rows[0];
  const check = u?.auth_provider === "local" ? await auth.verifyPassword(password, u.password_hash) : { ok: false };
  if (!check.ok) {
    audit.log(req, "auth.login_failed", { actor: { id: u?.id, login }, project: null, target: login });
    limits.loginIpLogin.hit(key);
    limits.loginIp.hit(req.ip);
    limits.loginAny.hit(login);
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  limits.loginIpLogin.clear(key);
  if (u.blocked) return res.status(403).json({ error: "Учётная запись заблокирована. Обратитесь к администратору" });
  // второй фактор: код из приложения-аутентификатора или резервный код. Без кода — просим его, попыткой это не считается
  const totp = (await pool.query("SELECT totp_secret IS NOT NULL AS on FROM users WHERE id=$1", [u.id])).rows[0]?.on;
  if (totp) {
    if (!req.body.code) return res.status(401).json({ error: "Введите код из приложения-аутентификатора", twoFactor: true });
    const second = await security.verifySecondFactor(u.id, req.body.code);
    if (!second.ok) {
      audit.log(req, "auth.2fa_failed", { actor: u, project: null, target: u.login });
      limits.loginIpLogin.hit(key);
      limits.loginIp.hit(req.ip);
      limits.loginAny.hit(login);
      return res.status(401).json({ error: "Код не подошёл. Введите новый код из приложения или резервный код", twoFactor: true });
    }
    if (second.method === "recovery") audit.log(req, "auth.recovery_used", { actor: u, project: null, target: u.login, details: { left: second.recoveryLeft } });
  }
  if (check.legacy) {
    // пароль из прошлой версии — сразу перехэшируем в bcrypt
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await auth.hashPassword(password), u.id]);
  }
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [u.id]);
  await auth.createSession(res, req, u.id);
  audit.log(req, "auth.login", { actor: u, project: null, target: u.login, details: { provider: u.auth_provider || "local" } });
  const user = me({ ...u, pending: await pendingOf(u.id), twoFactor: !!totp });
  res.json({ user });
}));

// двухфакторная аутентификация и активные сессии (server/account.js)
app.use("/api/auth", require("./account"));

app.post("/api/auth/logout", wrap(async (req, res) => {
  if (req.user) audit.log(req, "auth.logout", { project: null, target: req.user.login });
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

// Смена своего пароля. Остальные сессии закрываются: если пароль утёк, вошедший с ним теряет доступ
app.post("/api/auth/password", auth.requireUser, wrap(async (req, res) => {
  const current = typeof req.body.current === "string" ? req.body.current : "";
  const bad = auth.checkPassword(req.body.password, { login: req.user.login, name: req.user.name });
  if (bad) return res.status(400).json({ error: bad });
  if (!limits.password.take(String(req.user.id))) return res.status(429).json({ error: TOO_MANY });
  const { rows } = await pool.query("SELECT password_hash, auth_provider FROM users WHERE id=$1", [req.user.id]);
  if (rows[0].auth_provider !== "local") return res.status(409).json({ error: "Пароль внешней учётной записи меняется в её источнике" });
  if (!(await auth.verifyPassword(current, rows[0].password_hash)).ok) return res.status(403).json({ error: "Текущий пароль указан неверно" });
  if (current === req.body.password) return res.status(400).json({ error: "Новый пароль должен отличаться от текущего" });
  if (await security.reusedPassword(pool, req.user.id, req.body.password, auth.verifyPassword)) {
    return res.status(400).json({ error: `Этот пароль уже использовался. Придумайте новый (нельзя повторять последние ${security.cfg.history})` });
  }
  await security.setPassword(pool, req.user.id, await auth.hashPassword(req.body.password));
  await auth.destroyOtherSessions(req, req.user.id);
  audit.log(req, "auth.password", { project: null, target: req.user.login });
  res.json({ ok: true });
}));

// ---------- данные ----------
// Общее состояние (проекты со сводкой, пользователи, планы). Данные проекта — GET /api/projects/:key/state (server/state.js)
app.get("/api/state", auth.requireUser, wrap(async (req, res) => {
  res.json(await state.meta(req.user));
}));

app.post("/api/projects", auth.requireUser, access.requireWriter, wrap(async (req, res) => {
  const key = str(req.body.key, 10).toUpperCase();
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "Ключ: от 2 до 6 латинских букв" });
  const created = await tx(async (db) => {
    const { rows } = await db.query(
      "INSERT INTO projects(key, name, description, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key",
      [key, name, desc, req.user.id]
    );
    // создатель сразу становится участником, остальных добавляет админ
    if (rows[0]) await db.query("INSERT INTO project_members(project_key, user_id) VALUES ($1,$2)", [key, req.user.id]);
    return Boolean(rows[0]);
  });
  if (!created) {
    const { rows } = await pool.query("SELECT deleted_at FROM projects WHERE key=$1", [key]);
    return res.status(409).json({ error: rows[0]?.deleted_at ? `Ключ ${key} занят проектом в корзине: восстановите его или удалите навсегда` : `Ключ ${key} уже занят другим проектом` });
  }
  broadcast("projects");
  res.status(201).json({ id: key });
}));

// Новый проект из файла: экспорт BlackCat Testing или выгрузка другой TMS (TestRail, TestLink, Qase)
app.use("/api/projects-import", auth.requireUser, access.requireWriter, projectio.importRouter);

// Всё внутри проекта: доступ только участникам и админам, изменения — только тестировщикам и админам (кроме комментариев)
app.use("/api/projects/:key", auth.requireUser, access.project, live.inProject);
app.use("/api/projects/:key", state.router, lists.router, trash.router, casemodel.router, require("./reports").router);
app.use("/api/search", auth.requireUser, lists.searchRouter);
// Настройки интеграций содержат адреса и заголовки внутренних систем — их видят только те, кто может менять настройки
app.use(["/api/projects/:key/webhooks", "/api/projects/:key/tracker"], (req, res, next) =>
  access.can(req.projectRole, "settings") ? next() : res.status(403).json({ error: access.READ_ONLY }));

app.patch("/api/projects/:key", auth.requireUser, wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  const r = await pool.query("UPDATE projects SET name=$1, description=$2 WHERE key=$3", [name, desc, req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Проект не найден" });
  broadcast("projects");
  res.json({ ok: true });
}));

// Проект — в корзину (только админ, с подтверждением ключом). Навсегда — из корзины в «Пользователи» → «Корзина»
app.delete("/api/projects/:key", auth.requireUser, wrap(trash.deleteProject));

app.use("/api/projects/:key", require("./cases"));

// подсказки языковой модели в формах; запись (черновики бага и кейса) — только тестировщикам, как и сами формы
app.use("/api/notifications", auth.requireUser, require("./notify").router);
app.use("/api/projects/:key", auth.requireUser, require("./runs"), require("./bugs"), require("./comments"), folders.router, require("./casecopy").router, caseio.router, require("./caseimport").router, autotests.projectRouter, attachments.projectRouter);
app.use("/api/projects/:key", auth.requireUser, require("./requirements").router, require("./coverage").router, require("./templates").router, shared.router, review.router, datasets.router, require("./releases").router, require("./notify").projectRouter, plans.router, webhooks.router, trackers.router, ci.router, require("./analytics").router, projectio.projectRouter);
app.use("/api/tokens", auth.requireUser, autotests.tokenRouter);
app.use("/api/attachments", auth.requireUser, attachments.fileRouter);
app.use("/api/admin", auth.requireUser, access.requireAdmin, require("./backup").router, require("./users"), require("./personal").router, audit.router, trash.adminRouter);
// подключения к языковым моделям (облачные сервисы и свои модели) — только администратор

// Встроенная справка (docs/, README, CHANGELOG) — для всех вошедших
app.use("/api/help", auth.requireUser, require("./help").router);

// Лицензия (админ): условия действующего ключа, ввод нового ключа, возврат к бесплатной редакции
app.get("/api/admin/license", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  res.json({ edition: "lite", seats: await seats.usage(pool) });
}));

// Фоновые задачи (админ): сводка по очереди, упавшие задачи, повтор
app.get("/api/admin/jobs", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  res.json(await jobs.overview());
}));
app.post("/api/admin/jobs/:id/retry", auth.requireUser, access.requireAdmin, wrap(async (req, res) => {
  if (!(await jobs.retry(num(req.params.id)))) return res.status(404).json({ error: "Упавшая задача не найдена" });
  res.json({ ok: true });
}));

// О системе (админ): версия, сборка, база, история обновлений
app.get("/api/admin/system", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  const [pg, mig, vers] = await Promise.all([
    pool.query("SHOW server_version"),
    pool.query("SELECT name, applied_at FROM schema_migrations ORDER BY name DESC"),
    pool.query("SELECT version, first_started_at, last_started_at, commit FROM app_versions ORDER BY first_started_at DESC"),
  ]);
  res.json({
    version: version.VERSION, commit: version.COMMIT, built: version.BUILT, node: process.version,
    postgres: pg.rows[0].server_version,
    migrations: { count: mig.rows.length, last: mig.rows[0]?.name || null, lastAt: mig.rows[0]?.applied_at.getTime() || null },
    history: vers.rows.map((v) => ({ version: v.version, commit: v.commit, since: v.first_started_at.getTime(), last: v.last_started_at.getTime() })),
  });
}));

// Проверки для Docker и Kubernetes. livez — процесс жив; readyz — готов принимать запросы (база, миграции, хранилище);
// healthz — как раньше (база доступна), для docker-compose
let ready = false;
let stopping = false;
app.get("/livez", (_req, res) => res.json({ ok: true }));
app.get("/readyz", wrap(async (_req, res) => {
  if (!ready || stopping) return res.status(503).json({ ok: false, reason: stopping ? "stopping" : "starting" });
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));
// Метрики Prometheus — только с METRICS_TOKEN
app.get("/metrics", metrics.handler());
metrics.gauges({ pool, live, version });
app.get("/healthz", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "Не найдено" }));
// Скрипты отправки результатов автотестов: curl -O http://<адрес>/testball-reporter.js (Playwright) или /report.js (JUnit XML)
const CLIENT_SCRIPTS = { "testball-reporter.js": "playwright-reporter.js", "report.js": "report.js" };
app.get(["/testball-reporter.js", "/report.js"], (req, res) => {
  const name = req.path.slice(1);
  res.set("Content-Disposition", `attachment; filename="${name}"`);
  res.type("application/javascript").sendFile(path.join(__dirname, "..", "scripts", CLIENT_SCRIPTS[name]));
});
// Интерфейс собирается из web/ командой npm run build:web (в Docker — автоматически)
app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: 0 }));

app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный JSON" });
  // ошибки с понятным пользователю кодом (модель недоступна, сервер перегружен, тело слишком большое) — не ошибки сервера
  if (err.code === "23514" && err.constraint === "community_active_seats") return res.status(409).json({ error: seats.LIMIT_ERROR });
  if (err.code === "23514" && err.constraint === "community_active_projects") {
    return res.status(409).json({ error: "Доступно до 2 активных проектов Community. Переместите проект в корзину, чтобы освободить место." });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.expose && err.status) return res.status(err.status).json({ error: err.status === 413 ? "Слишком большой запрос" : "Некорректный запрос" });
  log.error("server", err.message, { reqId: req.id, method: req.method, path: req.originalUrl.split("?")[0], user: req.user?.login || null, err: err.code || err.name, stack: err.stack });
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: `Внутренняя ошибка сервера. Код запроса для поддержки: ${req.id}`, requestId: req.id });
});

(async () => {
  await waitForDb();
  const instance = await require("./db").lockInstance();
  await migrate();
  // Аварийный вход для админа: ADMIN_LOGIN в .env делает этого пользователя админом и снимает блокировку
  if (process.env.ADMIN_LOGIN) {
    const r = await pool.query("UPDATE users SET role='admin', blocked=false WHERE login=$1", [RESERVED_ADMIN]);
    console.log(r.rowCount ? `[server] ${process.env.ADMIN_LOGIN} — администратор` : `[server] ADMIN_LOGIN: пользователь ${process.env.ADMIN_LOGIN} не найден`);
  }
  await auth.prepareSetup();
  await secrets.init();
  await require("./storage").check();
  await live.listen();
  attachments.startSweeper();
  // уборка раз в час: корзина, журнал аудита, журнал вебхуков, выполненные фоновые задачи
  jobs.define("housekeeping", () => Promise.all([trash.purgeExpired(), audit.purge(), require("./personal").purgeIps(), webhooks.trimDeliveries(), jobs.cleanup()]), { maxAttempts: 1, title: "Уборка устаревших данных" });
  jobs.every("housekeeping", 60 * 60 * 1000);
  jobs.define("autoruns.expire", autotests.expireInactive, { maxAttempts: 2, title: "Проверка незавершённых прогонов CI" });
  jobs.every("autoruns.expire", 5 * 60 * 1000);
  require("./backup").startSchedule();
  trackers.startSync();
  jobs.start();
  const server = app.listen(PORT, HOST, () => {
    ready = true;
    console.log(`[server] BlackCat Testing Community ${version.VERSION}${version.COMMIT ? ` (${version.COMMIT.slice(0, 8)})` : ""} запущен: http://localhost:${PORT}`);
  });
  // Kubernetes присылает SIGTERM: сначала перестаём числиться готовыми, дожидаемся текущих запросов, закрываем соединения
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal}: останавливаемся`);
    live.closeAll();
    // фоновые задачи: новые не берём, текущие дожидаемся; невыполненные подхватит другая реплика
    const jobsDone = jobs.stop(10000);
    server.close(() => jobsDone.then(() => Promise.all([instance.end(), pool.end()])).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000)).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})().catch((e) => {
  console.error("[server] Не удалось запуститься:", e.message);
  process.exit(1);
});
