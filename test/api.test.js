// Интеграционные тесты HTTP API на настоящем PostgreSQL. Сценарии из docs/API.md
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { Client } = require("pg");
const { startServer, client, seed, SETUP_CODE } = require("./helpers");

let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
});
test.after(async () => srv && (await srv.stop()));

test("установка: первый пользователь только с кодом, дальше роль developer", async () => {
  const fresh = await startServer();
  try {
    const c = client(fresh.base);
    let r = await c.get("/api/auth/me");
    assert.equal(r.data.setup, true);
    r = await c.post("/api/auth/register", { login: "first", name: "F", password: "Tb-pass-2026", setupCode: "wrong" });
    assert.equal(r.status, 403);
    r = await c.post("/api/auth/register", { login: "first", name: "F", password: "Tb-pass-2026", setupCode: SETUP_CODE });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, "admin");
    const c2 = client(fresh.base);
    r = await c2.post("/api/auth/register", { login: "second", name: "S", password: "Tb-pass-2026" });
    assert.equal(r.data.user.role, "developer");
  } finally {
    await fresh.stop();
  }
});

test("вход: неверный пароль 401, без Content-Type 415, без сессии 401", async () => {
  const c = client(srv.base);
  assert.equal((await c.post("/api/auth/login", { login: "tester", password: "nope-nope" })).status, 401);
  const r = await fetch(srv.base + "/api/auth/login", { method: "POST", body: "login=tester" });
  assert.equal(r.status, 415);
  assert.equal((await c.get("/api/state")).status, 401);
});

test("доступ: чужой проект — 404, разработчик не меняет, но комментирует", async () => {
  assert.equal((await u.outsider.get("/api/projects/LK/plans")).status, 404);
  const st = await u.outsider.get("/api/state");
  assert.equal(st.data.projects.length, 0);
  assert.equal((await u.outsider.get("/api/projects/LK/state")).status, 404);
  let r = await u.dev.post("/api/projects/LK/cases", { title: "x", priority: "low", status: "draft" });
  assert.equal(r.status, 403);
  r = await u.tester.post("/api/projects/LK/cases", { title: "Комментируемый", priority: "low", status: "ready" });
  assert.equal(r.status, 201);
  r = await u.dev.post(`/api/projects/LK/cases/${r.data.num}/comments`, { text: "вопрос" });
  assert.equal(r.status, 201);
  r = await u.viewer.post("/api/projects/LK/cases/1/comments", { text: "нельзя" });
  assert.equal(r.status, 403);
});

test("кейсы: создание, частичное обновление, версии и защита от затирания", async () => {
  let r = await u.tester.post("/api/projects/LK/cases", { title: "Вход по паролю", priority: "high", status: "draft", steps: "Открыть\nВвести", expected: "Вошёл" });
  assert.equal(r.status, 201);
  const n = r.data.num;
  r = await u.tester.patch(`/api/projects/LK/cases/${n}`, { status: "ready", baseVersion: 1 });
  assert.equal(r.data.version, 2);
  assert.deepEqual(JSON.parse(r.headers.get("x-testball-changes")), [{ type: "cases", pid: "LK", caseNum: n }]);
  const delta = `/api/projects/LK/state?parts=cases,comments&caseNums=${n}`;
  const filtered = await u.tester.get(delta);
  assert.equal(filtered.status, 200);
  assert.deepEqual(Object.keys(filtered.data), ["pid", "cases", "comments"]);
  assert.deepEqual(filtered.data.cases.map((c) => [c.num, c.status, c.light]), [[n, "ready", true]]);
  assert.equal((await u.outsider.get(delta)).status, 404);
  assert.equal((await u.tester.get("/api/projects/LK/state?parts=cases,unknown")).status, 400);
  r = await u.tester.patch(`/api/projects/LK/cases/${n}`, { title: "Затирание", baseVersion: 1 });
  assert.equal(r.status, 409);
  r = await u.tester.get(`/api/projects/LK/cases/${n}/versions`);
  assert.equal(r.data.versions.length, 2);
  r = await u.tester.post(`/api/projects/LK/cases/${n}/versions/1/restore`);
  assert.equal(r.data.version, 3);
  r = await u.tester.post("/api/projects/LK/cases", { title: "", priority: "high", status: "draft" });
  assert.equal(r.status, 400);
  r = await u.tester.post("/api/projects/LK/cases", { title: "x", priority: "urgent", status: "draft" });
  assert.equal(r.status, 400);
});

test("кейсы: параллельные сохранения одной версии не затирают друг друга", async () => {
  const created = await u.tester.post("/api/projects/LK/cases", { title: "Исходный заголовок", priority: "low", status: "draft" });
  assert.equal(created.status, 201);
  const url = `/api/projects/LK/cases/${created.data.num}`;
  const initial = (await u.tester.get(url)).data;
  const titles = ["Правка тестировщика", "Правка администратора"];
  const db = new Client({ connectionString: srv.dbUrl });
  await db.connect();
  let saves;
  try {
    await db.query("BEGIN");
    // Оба запроса успевают прочитать исходный кейс и ждут именно на UPDATE.
    await db.query("SELECT id FROM test_cases WHERE project_key='LK' AND num=$1 FOR UPDATE", [created.data.num]);
    saves = Promise.all([u.tester, u.admin].map((user, i) => user.patch(url, { title: titles[i], baseVersion: initial.version })));
    const deadline = Date.now() + 5000;
    for (;;) {
      await db.query("SELECT pg_stat_clear_snapshot()");
      const { rows } = await db.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE test_cases SET folder_id=%'`);
      if (rows[0].waiting === 2) break;
      assert.ok(Date.now() < deadline, "оба запроса должны ждать на UPDATE");
      await delay(20);
    }
  } finally {
    await db.end(); // освобождаем блокировку, откатывая транзакцию без изменений
  }
  const responses = await saves;
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = (await u.tester.get(url)).data;
  const rejected = responses.find((r) => r.status === 409);
  assert.equal(current.title, titles[responses.findIndex((r) => r.status === 200)]);
  assert.equal(current.version, initial.version + 1);
  assert.equal(rejected.data.version, current.version);
  assert.equal(rejected.data.editRevision, current.editRevision);
});

test("кейсы: перенос в папку инвалидирует открытый редактор без новой версии истории", async () => {
  const created = await u.tester.post("/api/projects/LK/cases", { title: "Кейс для переноса", priority: "low", status: "draft" });
  assert.equal(created.status, 201);
  const url = `/api/projects/LK/cases/${created.data.num}`;
  const initial = (await u.tester.get(url)).data;
  const folder = await u.tester.post("/api/projects/LK/folders", { name: "Параллельный перенос" });
  assert.equal(folder.status, 201);
  assert.equal((await u.admin.post("/api/projects/LK/cases/move", { nums: [created.data.num], folder: folder.data.id })).data.moved, 1);

  const stale = await u.tester.patch(url, { title: "Устаревший черновик", folder: null, baseVersion: initial.version, baseEditRevision: initial.editRevision });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.version, initial.version);
  assert.equal(stale.data.editRevision, initial.editRevision + 1);
  assert.equal((await u.tester.patch(url, { status: "ready" })).status, 200);
  const current = (await u.tester.get(url)).data;
  assert.equal(current.folder, folder.data.id);
  assert.equal(current.title, initial.title);
  assert.equal(current.status, "ready");
});

test("прогон: результаты, чек-лист по пунктам, закрытый прогон 409", async () => {
  const a = await u.tester.post("/api/projects/LK/cases", { title: "Кейс", priority: "medium", status: "ready", steps: "a" });
  const b = await u.tester.post("/api/projects/LK/cases", { kind: "checklist", title: "Смоук", priority: "medium", status: "ready", steps: "1. Вход\n2. Выход" });
  let r = await u.tester.post("/api/projects/LK/runs", { title: "Регресс", caseNums: [a.data.num, b.data.num, 9999] });
  assert.equal(r.status, 201);
  const run = r.data.num;
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a.data.num}`, { result: "failed", comment: "упал" });
  assert.equal(r.status, 200);
  const delta = await u.tester.get(`/api/projects/LK/state?parts=runs,results&caseNums=${a.data.num}`);
  assert.equal(delta.status, 200);
  assert.equal(delta.data.runs.find((x) => x.num === run).counts.failed, 1);
  assert.deepEqual(delta.data.results.map((x) => [x.caseNum, x.result]), [[a.data.num, "failed"]]);
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { result: "passed" });
  assert.equal(r.status, 400, "у чек-листа отмечаются пункты");
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Вход", result: "passed" });
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Нет такого", result: "passed" });
  assert.equal(r.status, 404);
  let st = await u.tester.get(`/api/projects/LK/runs/${run}/results`);
  const res = (num) => st.data.results.find((x) => x.runNum === run && x.caseNum === num);
  assert.equal(res(a.data.num).result, "failed");
  assert.equal(res(b.data.num).result, "untested");
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Выход", result: "passed" });
  st = await u.tester.get(`/api/projects/LK/runs/${run}/results`);
  assert.equal(res(b.data.num).result, "passed");
  await u.tester.patch(`/api/projects/LK/runs/${run}`, { state: "closed" });
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a.data.num}`, { result: "passed" });
  assert.equal(r.status, 409);
});

test("баги: жизненный цикл и недопустимые переходы", async () => {
  let r = await u.tester.post("/api/projects/LK/bugs", { title: "Не входит", severity: "critical", assignee: "dev" });
  assert.equal(r.status, 201);
  const n = r.data.num;
  assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${n}`, { status: "closed" })).status, 409);
  for (const s of ["in_progress", "fixed", "verified", "closed"]) assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${n}`, { status: s })).status, 200, s);
  r = await u.tester.post("/api/projects/LK/bugs", { title: "Дубль", severity: "minor" });
  assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${r.data.num}`, { status: "duplicate" })).status, 400);
  assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${r.data.num}`, { status: "duplicate", duplicateOf: n })).status, 200);
  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: "x", severity: "minor", assignee: "outsider" })).status, 400);
});

test("CSV: пробный импорт ничего не пишет, ошибки по строкам, экспорт с BOM", async () => {
  const csv = "Название;Приоритет;Папка\nИмпорт 1;Высокий;Импорт / Вход\n;Низкий;\nИмпорт 2;Normal;\n";
  let r = await u.tester.post("/api/projects/LK/cases/import", { csv, dryRun: true });
  assert.equal(r.data.errorCount, 1);
  r = await u.tester.post("/api/projects/LK/cases/import", { csv, dryRun: false });
  assert.equal(r.status, 400, "при ошибке не импортируется ничего");
  r = await u.tester.post("/api/projects/LK/cases/import", { csv: "Название;Приоритет;Папка\nИмпорт 1;Высокий;Импорт / Вход\n" });
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.create, 1);
  const raw = await fetch(srv.base + "/api/projects/LK/cases/export", { headers: { cookie: u.tester.cookie } });
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 с BOM для Excel");
  assert.match(bytes.toString("utf8"), /Импорт 1/);
});

test("токен: только отправка результатов автотестов", async () => {
  let r = await u.tester.post("/api/tokens", { name: "CI", project: "LK" });
  assert.equal(r.status, 201);
  const ci = client(srv.base, { token: r.data.token });
  assert.equal((await ci.get("/api/state")).status, 403);
  r = await ci.post("/api/projects/LK/autoruns", { title: "Смоук", build: "b1" });
  assert.equal(r.status, 201);
  const run = r.data.num;
  r = await ci.post(`/api/projects/LK/autoruns/${run}/results`, { results: [{ suite: "auth", name: "Вход", status: "failed", message: "нет кнопки" }, { name: "Выход", status: "passed" }] });
  assert.equal(r.data.ids.length, 2);
  assert.equal((await ci.get(`/api/projects/LK/autoruns/${run}`)).status, 403);
  assert.equal((await ci.patch(`/api/projects/LK/autoruns/${run}`, { state: "finished" })).status, 200);
  r = await u.tester.get(`/api/projects/LK/autoruns/${run}`);
  assert.equal(r.data.results.length, 2);
  assert.equal((await u.dev.post("/api/tokens", { name: "dev" })).status, 403);
});

test("публичный API: права токена read/write, /api/v1, срок действия", async () => {
  // наблюдателю доступен только токен на чтение
  assert.equal((await u.viewer.post("/api/tokens", { name: "v", project: "LK" })).status, 403);
  let r = await u.viewer.post("/api/tokens", { name: "v", project: "LK", scopes: ["read"] });
  assert.equal(r.status, 201);
  const ro = client(srv.base, { token: r.data.token });
  assert.equal((await ro.get("/api/v1/projects/LK/state")).status, 200);
  assert.equal((await ro.get("/api/v1/projects/LK/cases")).status, 200);
  assert.equal((await ro.post("/api/v1/projects/LK/cases", { title: "x" })).status, 403);
  assert.equal((await ro.get("/api/v1/tokens")).status, 403, "токенами токен не управляет");
  assert.equal((await u.tester.post("/api/tokens", { name: "bad", scopes: ["root"] })).status, 400);
  // write-токен тестировщика может создавать кейсы, но только в своём проекте
  r = await u.tester.post("/api/tokens", { name: "sync", project: "LK", scopes: ["read", "write"] });
  const rw = client(srv.base, { token: r.data.token });
  r = await rw.post("/api/v1/projects/LK/cases", { title: "Создан по API", priority: "low", status: "draft" });
  assert.equal(r.status, 201);
  assert.equal((await rw.get("/api/v1/admin/users")).status, 403);
  r = await u.tester.get("/api/tokens");
  assert.deepEqual(r.data.tokens.find((t) => t.name === "sync").scopes, ["read", "write"]);
  // истёкший токен не работает
  r = await u.tester.post("/api/tokens", { name: "old", scopes: ["read"], expiresDays: 1 });
  const old = client(srv.base, { token: r.data.token });
  assert.equal((await old.get("/api/v1/state")).status, 200);
  const { Client } = require("pg");
  const pg = new Client({ connectionString: srv.dbUrl });
  await pg.connect();
  await pg.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE name='old'");
  await pg.end();
  assert.equal((await old.get("/api/v1/state")).status, 401);
});

test("версия: в /api/auth/me и сведения о системе для админа", async () => {
  const v = require("../package.json").version;
  assert.equal((await u.tester.get("/api/auth/me")).data.user.version, v);
  assert.equal((await u.tester.get("/api/admin/system")).status, 403);
  const r = await u.admin.get("/api/admin/system");
  assert.equal(r.data.version, v);
  assert.ok(r.data.migrations.count >= 18);
  assert.equal(r.data.history[0].version, v);
});

test("Community: API функций Enterprise не доступен", async () => {
  for (const path of [
    "/api/llm/status",
    "/api/admin/llm",
    "/api/projects/LK/ai/bug-draft",
    "/api/projects/LK/configs",
    "/api/projects-import/testit/connect",
  ]) {
    const response = path.endsWith("bug-draft") || path.endsWith("connect")
      ? await u.admin.post(path, {})
      : await u.admin.get(path);
    assert.equal(response.status, 404, path);
  }
});

test("Community: пять общих мест, в том числе при параллельных добавлении и разблокировке", async () => {
  const isolated = await startServer();
  try {
    const admin = client(isolated.base);
    const password = "Tb-pass-2026";
    assert.equal((await admin.post("/api/auth/register", { login: "owner", name: "Владелец", password, setupCode: SETUP_CODE })).status, 201);
    const add = (login, role) => admin.post("/api/admin/users", { login, name: "Участник", password, role });
    for (const [login, role] of [["testone", "tester"], ["devone", "developer"], ["viewone", "viewer"]]) {
      assert.equal((await add(login, role)).status, 201);
    }
    const concurrent = await Promise.all([add("viewtwo", "viewer"), add("devtwo", "developer")]);
    assert.deepEqual(concurrent.map((entry) => entry.status).sort(), [201, 409]);
    const license = await admin.get("/api/admin/license");
    assert.equal(license.status, 200);
    assert.equal(license.data.edition, "lite");
    assert.deepEqual(license.data.seats, { used: 5, limit: 5 });
    assert.equal((await client(isolated.base).post("/api/auth/register", { login: "selfreg", name: "Сам Записался", password })).status, 409);
    assert.equal((await admin.patch("/api/admin/users/viewone", { role: "tester" })).status, 200);
    assert.equal((await admin.patch("/api/admin/users/viewone", { blocked: true })).status, 200);
    const combined = await Promise.all([
      admin.patch("/api/admin/users/viewone", { blocked: false }),
      add("testtwo", "tester"),
    ]);
    assert.deepEqual(combined.map((entry) => entry.status).sort(), [200, 409]);
    assert.deepEqual((await admin.get("/api/admin/license")).data.seats, { used: 5, limit: 5 });
    assert.equal((await u.tester.get("/api/admin/license")).status, 403);
    assert.equal((await admin.put("/api/admin/license", { key: "TB1.e30.AAAA" })).status, 404);
  } finally {
    await isolated.stop();
  }
});

test("Community: корпоративное администрирование недоступно даже администратору", async () => {
  for (const route of ["/api/auth/oidc/start", "/api/auth/kerberos", "/api/admin/roles", "/api/projects/LK/configs"]) {
    assert.equal((await u.admin.get(route)).status, 404, route);
  }
  assert.equal((await u.admin.post("/api/admin/roles", { name: "Новая роль", permissions: [] })).status, 404);
  assert.equal((await u.admin.put("/api/projects/LK/review-settings", { required: true })).status, 404);
  assert.equal((await u.admin.post("/api/projects/LK/runs", { title: "Кросс-браузерный прогон", config: { Браузер: "Chrome" } })).status, 403);
});

test("требования: связь с кейсами, покрытие по результатам, баги, матрица, импорт", async () => {
  const mk = async (title) => (await u.tester.post("/api/projects/LK/cases", { title, priority: "high", status: "ready" })).data.num;
  const c1 = await mk("Трассировка: вход");
  const c2 = await mk("Трассировка: выход");
  let r = await u.tester.post("/api/projects/LK/requirements", { title: "Пользователь входит по паролю", extRef: "AUTH-1", cases: [c1, c2] });
  assert.equal(r.status, 201);
  const req1 = r.data.num;
  r = await u.tester.post("/api/projects/LK/requirements", { title: "Без кейсов" });
  const req2 = r.data.num;
  assert.equal((await u.tester.post("/api/projects/LK/requirements", { title: "x", cases: [99999] })).status, 400);
  assert.equal((await u.viewer.post("/api/projects/LK/requirements", { title: "x" })).status, 403);
  assert.equal((await u.outsider.get("/api/projects/LK/requirements")).status, 404);

  const cov = async () => Object.fromEntries((await u.viewer.get("/api/projects/LK/requirements")).data.items.map((x) => [x.num, x.coverage]));
  assert.deepEqual([(await cov())[req1], (await cov())[req2]], ["untested", "none"]);
  // прогон: первый кейс прошёл → частично; второй упал → провалено, баг по нему виден в требовании
  r = await u.tester.post("/api/projects/LK/runs", { title: "Трассировка", caseNums: [c1, c2] });
  const run = r.data.num;
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${c1}`, { result: "passed" });
  assert.equal((await cov())[req1], "partial");
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${c2}`, { result: "failed" });
  assert.equal((await cov())[req1], "failed");
  await u.tester.post("/api/projects/LK/bugs", { title: "Выход не работает", severity: "major", caseNum: c2, runNum: run });
  r = await u.viewer.get(`/api/projects/LK/requirements/${req1}`);
  assert.equal(r.data.caseList.length, 2);
  assert.equal(r.data.bugs.length, 1);
  assert.equal(r.data.openBugs, 1);
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${c2}`, { result: "passed" });
  assert.equal((await cov())[req1], "passed");
  // связь из карточки кейса
  assert.equal((await u.tester.post(`/api/projects/LK/requirements/${req2}/link`, { caseNum: c1 })).status, 200);
  r = await u.viewer.get(`/api/projects/LK/cases/${c1}/requirements`);
  assert.deepEqual(r.data.items.map((x) => x.num), [req1, req2]);
  await u.tester.post(`/api/projects/LK/requirements/${req2}/link`, { caseNum: c1, linked: false });
  assert.equal((await cov())[req2], "none");
  // матрица трассировки
  const csv = (await u.tester.get("/api/projects/LK/requirements/matrix.csv")).data;
  assert.match(csv, /AUTH-1/);
  assert.match(csv, new RegExp(`LK-${c2};Трассировка: выход;Пройден`));
  // импорт: тот же ключ обновляет, новый — создаёт
  r = await u.tester.post("/api/projects/LK/requirements/import", { items: [
    { title: "Вход по паролю и коду", extRef: "AUTH-1" },
    { title: "Восстановление пароля", extRef: "AUTH-2", cases: [c1] },
    { title: "", extRef: "AUTH-3" },
  ] });
  assert.deepEqual([r.data.created, r.data.updated, r.data.errors.length], [1, 1, 1]);
  r = await u.viewer.get(`/api/projects/LK/requirements/${req1}`);
  assert.equal(r.data.title, "Вход по паролю и коду");
  assert.equal(r.data.cases.length, 2, "связи при импорте не теряются");
  assert.equal((await u.tester.del(`/api/projects/LK/requirements/${req2}`)).status, 200);
  assert.equal((await u.viewer.get(`/api/projects/LK/requirements/${req2}`)).status, 404);
});

test("справка: доступна вошедшим, ссылки переписаны на страницы справки", async () => {
  const anon = client(srv.base);
  assert.equal((await anon.get("/api/help/user")).status, 401);
  const list = (await u.viewer.get("/api/help")).data.pages.map((p) => p.key);
  assert.ok(list.includes("user") && list.includes("admin") && list.includes("api"));
  const r = await u.viewer.get("/api/help/user");
  assert.equal(r.status, 200);
  assert.match(r.data.html, /<h2 id="h-прогоны-как-проводить-тестирование">/);
  assert.ok(r.data.html.includes(`href="#/help/admin/${encodeURIComponent("перенос-данных-из-других-систем")}"`));
  assert.equal((await u.viewer.get("/api/help/secret")).status, 404);
  assert.equal((await u.viewer.get("/api/help/..%2F..%2Fetc%2Fpasswd")).status, 404);
});

test("метрики без METRICS_TOKEN выключены", async () => {
  assert.equal((await fetch(`${srv.base}/metrics`)).status, 404);
});

test("автотест связывается с кейсом по номеру в названии, тегу или списку cases; ручную связь не перезаписывает", async () => {
  const mk = async (title) => (await u.tester.post("/api/projects/LK/cases", { title, priority: "high", status: "ready" })).data.num;
  const [a, b, c, d] = [await mk("Связь: в названии"), await mk("Связь: в наборе"), await mk("Связь: cases"), await mk("Связь: ручная")];
  const run = (await u.tester.post("/api/projects/LK/autoruns", { title: "Связи" })).data.num;
  await u.tester.post(`/api/projects/LK/autoruns/${run}/results`, { results: [
    { suite: "auth", name: `Вход по паролю @LK-${a}`, status: "passed" },
    { suite: `[LK-${b}] Профиль`, name: "Смена имени", status: "failed" },
    { name: "Оплата", status: "passed", cases: [`@LK-${c}`] },
    { name: "Чужой проект PAY-12 и LKX-1 и XLK-1", status: "passed" },
  ] });
  const tests = (await u.tester.get("/api/projects/LK/autotests")).data;
  const list = Array.isArray(tests) ? tests : tests.items || tests.tests;
  const byName = (n) => list.find((t) => t.name === n);
  assert.equal(byName(`Вход по паролю @LK-${a}`).caseNum, a);
  assert.equal(byName("Смена имени").caseNum, b);
  assert.equal(byName("Оплата").caseNum, c);
  assert.equal(byName("Чужой проект PAY-12 и LKX-1 и XLK-1").caseNum, null);
  // ручная связь остаётся, даже если в названии другой номер
  const t = byName("Оплата");
  await u.tester.patch(`/api/projects/LK/autotests/${t.id}`, { caseNum: d });
  await u.tester.post(`/api/projects/LK/autoruns/${run}/results`, { results: [{ name: "Оплата", status: "failed", cases: [`LK-${c}`] }] });
  const again = (await u.tester.get("/api/projects/LK/autotests")).data;
  assert.equal((Array.isArray(again) ? again : again.items || again.tests).find((x) => x.name === "Оплата").caseNum, d);
});

test("аналитика: предрасчёт, ответ из кэша, пересчёт по кнопке", async () => {
  const first = await u.viewer.get("/api/projects/LK/analytics?days=180");
  assert.equal(first.status, 200);
  assert.ok(first.data.computedAt > 0);
  assert.equal(first.data.refreshing, false);
  const total = first.data.cases.total;
  // новый кейс: в течение минуты аналитика отдаётся из кэша, без пересчёта
  await u.tester.post("/api/projects/LK/cases", { title: "Для аналитики", priority: "low", status: "draft" });
  const cached = await u.viewer.get("/api/projects/LK/analytics?days=180");
  assert.equal(cached.data.computedAt, first.data.computedAt);
  assert.equal(cached.data.cases.total, total);
  // «Пересчитать»
  const fresh = await u.viewer.get("/api/projects/LK/analytics?days=180&fresh=1");
  assert.equal(fresh.data.cases.total, total + 1);
  assert.ok(fresh.data.computedAt >= first.data.computedAt);
});

test("перезапуск упавших: новый прогон из упавших и заблокированных, исполнители и ссылка на исходный", async () => {
  const mk = async (title) => (await u.tester.post("/api/projects/LK/cases", { title, priority: "medium", status: "ready" })).data.num;
  const [a, b, c, d] = [await mk("Перезапуск А"), await mk("Перезапуск Б"), await mk("Перезапуск В"), await mk("Перезапуск Г")];
  const run = (await u.tester.post("/api/projects/LK/runs", { title: "Регресс 5.1", build: "5.1.0", env: "stage", caseNums: [a, b, c, d] })).data.num;
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a}`, { result: "passed" });
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b}`, { result: "failed", assignee: "tester" });
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${c}`, { result: "blocked" });
  assert.equal((await u.viewer.post(`/api/projects/LK/runs/${run}/rerun`, {})).status, 403);
  let r = await u.tester.post(`/api/projects/LK/runs/${run}/rerun`, { build: "5.1.1" });
  assert.equal(r.status, 201);
  assert.equal(r.data.cases, 2);
  const rerun = r.data.num;
  const st = (await u.tester.get("/api/projects/LK/state")).data;
  const nr = st.runs.find((x) => x.num === rerun);
  assert.equal(nr.title, "Регресс 5.1 — перезапуск");
  assert.equal(nr.build, "5.1.1");
  assert.equal(nr.env, "stage");
  assert.equal(nr.rerunOf, run);
  assert.equal(nr.counts.untested, 2);
  const results = (await u.tester.get(`/api/projects/LK/runs/${rerun}/results`)).data;
  const items = results.results || results.items || results;
  const byCase = Object.fromEntries(items.map((x) => [x.caseNum ?? x.case, x]));
  assert.equal(byCase[b].assignee, "tester", "исполнитель перенесён");
  assert.ok(!byCase[a] && !byCase[d], "пройденный и непроверенный не попали");
  // выбор результатов: только непроверенные
  r = await u.tester.post(`/api/projects/LK/runs/${run}/rerun`, { results: ["untested"] });
  assert.equal(r.data.cases, 1);
  assert.equal((await u.tester.post(`/api/projects/LK/runs/${rerun}/rerun`, { results: ["passed"] })).status, 409);
});

test("массовое изменение кейсов: статус, приоритет, теги, поля; новая версия; удаление в корзину", async () => {
  const mk = async (title, tags) => (await u.tester.post("/api/projects/LK/cases", { title, priority: "low", status: "draft", tags })).data.num;
  const a = await mk("Массово А", ["smoke"]);
  const b = await mk("Массово Б", ["smoke", "old"]);
  const c = await mk("Массово В", []);
  const field = (await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "Платформа", type: "select", options: ["web", "ios"] })).data;
  const fid = field.id ?? field.field?.id;
  let r = await u.tester.post("/api/projects/LK/cases/bulk", { nums: [a, b, c], status: "ready", priority: "high", addTags: ["regress"], removeTags: ["old"], fields: { [fid]: "web" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.changed, 3);
  const items = (await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("Массово"))).data.items;
  const byNum = Object.fromEntries(items.map((x) => [x.num, x]));
  assert.deepEqual([byNum[a].status, byNum[a].priority], ["ready", "high"]);
  assert.deepEqual(byNum[a].tags.sort(), ["regress", "smoke"]);
  assert.deepEqual(byNum[b].tags.sort(), ["regress", "smoke"]);
  assert.equal(byNum[c].fields[fid], "web");
  const hist = (await u.tester.get(`/api/projects/LK/cases/${a}/history`)).data;
  const full = (await u.tester.get(`/api/projects/LK/cases/${a}`)).data;
  assert.equal(full.version, 2, "новая версия");
  assert.ok(hist);
  // повтор ничего не меняет
  r = await u.tester.post("/api/projects/LK/cases/bulk", { nums: [a, b, c], status: "ready" });
  assert.equal(r.data.changed, 0);
  assert.equal((await u.tester.post("/api/projects/LK/cases/bulk", { nums: [a], status: "bad" })).status, 400);
  assert.equal((await u.viewer.post("/api/projects/LK/cases/bulk", { nums: [a], status: "draft" })).status, 403);
  r = await u.tester.post("/api/projects/LK/cases/bulk-delete", { nums: [b, c] });
  assert.equal(r.data.deleted, 2);
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${b}`)).status, 404);
  const trash = (await u.tester.get("/api/projects/LK/trash")).data;
  assert.ok((trash.items || trash).filter((t) => /Массово/.test(t.title)).length >= 2);
});

test("шаблоны кейсов и багов: сохранение, по умолчанию один, права, перенос при экспорте", async () => {
  let r = await u.tester.post("/api/projects/LK/templates", { kind: "case", name: "API-проверка", isDefault: true,
    data: { priority: "high", pre: "Получен токен", stepList: [{ action: "Отправить запрос", expected: "200 OK" }], tags: ["api"], title: "не сохраняется", junk: 1 } });
  assert.equal(r.status, 201);
  const t1 = r.data.id;
  r = await u.tester.post("/api/projects/LK/templates", { kind: "case", name: "UI", isDefault: true, data: { pre: "Открыт браузер" } });
  const t2 = r.data.id;
  assert.equal((await u.tester.post("/api/projects/LK/templates", { kind: "case", name: "ui", data: {} })).status, 409);
  assert.equal((await u.tester.post("/api/projects/LK/templates", { kind: "run", name: "x", data: {} })).status, 400);
  assert.equal((await u.viewer.post("/api/projects/LK/templates", { kind: "bug", name: "x", data: {} })).status, 403);
  await u.tester.post("/api/projects/LK/templates", { kind: "bug", name: "Вёрстка", data: { severity: "minor", env: "Chrome", tags: ["ui"] } });
  const list = (await u.viewer.get("/api/projects/LK/templates?kind=case")).data.templates;
  assert.deepEqual(list.filter((t) => t.isDefault).map((t) => t.id), [t2], "по умолчанию — только последний отмеченный");
  const api = list.find((t) => t.id === t1);
  assert.deepEqual(Object.keys(api.data).sort(), ["pre", "priority", "stepList", "tags"]);
  assert.equal(api.data.stepList[0].expected, "200 OK");
  assert.equal((await u.tester.patch(`/api/projects/LK/templates/${t1}`, { name: "API" })).status, 200);
  assert.equal((await u.viewer.get("/api/projects/LK/templates?kind=bug")).data.templates.length, 1);
  // экспорт и импорт проекта переносят шаблоны
  const exp = await u.tester.get("/api/projects/LK/export");
  assert.equal(exp.data.templates.length, 3);
  r = await u.admin.post("/api/projects-import", { source: "testball", data: exp.data, key: "TPL" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await u.admin.get("/api/projects/TPL/templates")).data.templates.length, 3);
  assert.equal((await u.admin.del("/api/projects/TPL", { confirm: "TPL" })).status, 200);
  assert.equal((await u.tester.del(`/api/projects/LK/templates/${t2}`)).status, 200);
});

test("тест-планы: динамический фильтр, блокировка, прогон по плану", async () => {
  let r = await u.tester.post("/api/projects/LK/plans", { title: "Высокий приоритет", mode: "dynamic", filter: { priorities: ["high"], statuses: ["ready", "draft"] } });
  assert.equal(r.status, 201);
  const p = r.data.num;
  r = await u.tester.get(`/api/projects/LK/plans/${p}/cases`);
  assert.ok(r.data.cases.length >= 1);
  assert.ok(r.data.cases.every((c) => c.priority === "high"));
  assert.equal((await u.tester.post(`/api/projects/LK/plans/${p}/lock`)).status, 200);
  assert.equal((await u.tester.del(`/api/projects/LK/plans/${p}`)).status, 409);
  r = await u.tester.post(`/api/projects/LK/plans/${p}/runs`, { title: "По плану" });
  assert.equal(r.status, 201);
});

test("администрирование: блокировка выкидывает из сессий, свою роль не поменять", async () => {
  try {
    assert.equal((await u.outsider.get("/api/state")).status, 200);
    assert.equal((await u.admin.patch("/api/admin/users/outsider", { blocked: true })).status, 200);
    assert.equal((await u.outsider.get("/api/state")).status, 401);
    assert.equal((await u.admin.patch("/api/admin/users/admin", { role: "tester" })).status, 409);
    assert.equal((await u.tester.get("/api/admin/users")).status, 403);
  } finally {
    assert.equal((await u.admin.patch("/api/admin/users/outsider", { blocked: false })).status, 200);
    assert.equal((await u.outsider.post("/api/auth/login", { login: "outsider", password: "Tb-pass-2026" })).status, 200);
  }
});

test("служебное: проверки готовности и заголовки безопасности", async () => {
  const r = await fetch(srv.base + "/readyz");
  assert.equal(r.status, 200);
  const page = await fetch(srv.base + "/api/auth/me");
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});

test("состояние: общее без данных проектов, проект — отдельно, сводка и история", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "История", priority: "low", status: "ready" });
  const r1 = await u.tester.post("/api/projects/LK/runs", { title: "R1", caseNums: [k.data.num] });
  await u.tester.patch(`/api/projects/LK/runs/${r1.data.num}/results/${k.data.num}`, { result: "failed" });
  const r2 = await u.tester.post("/api/projects/LK/runs", { title: "R2", caseNums: [k.data.num] });
  await u.tester.patch(`/api/projects/LK/runs/${r2.data.num}/results/${k.data.num}`, { result: "passed" });

  const meta = await u.tester.get("/api/state");
  assert.equal(meta.data.cases, undefined, "общее состояние не тащит кейсы");
  const lk = meta.data.projects.find((p) => p.id === "LK");
  assert.ok(lk.stats.cases >= 1 && lk.stats.last.passed >= 1);

  const ps = await u.tester.get("/api/projects/LK/state");
  const last = ps.data.results.filter((r) => r.caseNum === k.data.num);
  assert.equal(last.length, 1, "в состоянии проекта только последний результат кейса");
  assert.equal(last[0].result, "passed");
  const run2 = ps.data.runs.find((r) => r.num === r2.data.num);
  assert.equal(run2.counts.passed, 1);

  const rr = await u.tester.get(`/api/projects/LK/runs/${r2.data.num}/results`);
  assert.equal(rr.data.previous.find((r) => r.caseNum === k.data.num).result, "failed");
  const h = await u.tester.get(`/api/projects/LK/cases/${k.data.num}/history`);
  assert.deepEqual(h.data.results.map((r) => r.result), ["passed", "failed"]);

  // ETag: повторный запрос без изменений — 304
  const raw = await fetch(srv.base + "/api/projects/LK/state", { headers: { cookie: u.tester.cookie } });
  const etag = raw.headers.get("etag");
  // fetch сам помечает условные запросы как no-cache, поэтому — через http, как браузер с кэшем
  const status = await new Promise((resolve, reject) =>
    require("node:http").get(srv.base + "/api/projects/LK/state", { headers: { cookie: u.tester.cookie, "if-none-match": etag } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject)
  );
  assert.equal(status, 304);
});

test("живые события: несут проект и не приходят о чужих проектах", async () => {
  await u.admin.post("/api/projects", { key: "XX", name: "Чужой" });
  const ctrl = new AbortController();
  const got = [];
  const r = await fetch(srv.base + "/api/events", { headers: { cookie: u.tester.cookie }, signal: ctrl.signal });
  const reader = r.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      for (const m of dec.decode(value).matchAll(/data: (\{.*\})/g)) got.push(JSON.parse(m[1]));
    }
  })();
  await new Promise((res) => setTimeout(res, 400));
  await u.admin.post("/api/projects/XX/cases", { title: "секрет", priority: "low", status: "ready" });
  await u.tester.post("/api/projects/LK/cases", { title: "наш", priority: "low", status: "ready" });
  await new Promise((res) => setTimeout(res, 600));
  ctrl.abort();
  await pump;
  assert.ok(got.some((e) => e.type === "cases" && e.pid === "LK"));
  assert.ok(!got.some((e) => e.pid === "XX"), "о чужом проекте сигналов нет");
  assert.equal((await u.admin.del("/api/projects/XX", { confirm: "XX" })).status, 200);
});

test("списки: постраничная выдача, фильтры, поиск с морфологией и по ID", async () => {
  for (let i = 1; i <= 7; i++) await u.tester.post("/api/projects/LK/cases", { title: `Оплата картой ${i}`, priority: i % 2 ? "high" : "low", status: "ready", steps: "Ввести номер карты" });
  await u.tester.post("/api/projects/LK/cases", { title: "Восстановление пароля", priority: "low", status: "draft" });
  let r = await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("оплаты") + "&limit=3&count=1");
  assert.equal(r.data.items.length, 3);
  assert.equal(r.data.total, 7, "«оплаты» находит «Оплата» — русская морфология");
  const second = await u.tester.get(`/api/projects/LK/cases?q=${encodeURIComponent("оплаты")}&limit=3&after=${r.data.next}`);
  assert.equal(second.data.items.length, 3);
  assert.ok(second.data.items[0].num > r.data.items[2].num);
  r = await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("карты") + "&priority=high&count=1");
  assert.equal(r.data.total, 4, "поиск по шагам и фильтр по приоритету");
  const one = r.data.items[0];
  r = await u.tester.get(`/api/projects/LK/cases?q=LK-${one.num}`);
  assert.equal(r.data.items[0].num, one.num);

  await u.tester.post("/api/projects/LK/bugs", { title: "Ошибка при оплате картой", severity: "major" });
  r = await u.tester.get("/api/projects/LK/bugs?q=" + encodeURIComponent("оплата") + "&status=new");
  assert.ok(r.data.items.some((b) => /оплате/.test(b.title)));
  r = await u.tester.get("/api/projects/LK/runs?state=closed");
  assert.ok(r.data.items.every((x) => x.state === "closed"));

  r = await u.tester.get("/api/search?q=" + encodeURIComponent("оплата"));
  assert.ok(r.data.cases.length >= 1 && r.data.bugs.length >= 1);
  r = await u.outsider.get("/api/search?q=" + encodeURIComponent("оплата"));
  assert.equal(r.data.cases.length, 0, "чужие проекты в поиске не видны");
  r = await u.tester.get(`/api/search?q=LK-${one.num}`);
  assert.equal(r.data.cases[0].num, one.num);
});

test("корзина: кейс, прогон и баг восстанавливаются с результатами, комментариями и номерами", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "В корзину", priority: "low", status: "ready", steps: "шаг" });
  const run = await u.tester.post("/api/projects/LK/runs", { title: "Прогон для корзины", caseNums: [k.data.num] });
  await u.tester.patch(`/api/projects/LK/runs/${run.data.num}/results/${k.data.num}`, { result: "failed", comment: "упал" });
  const bug = await u.tester.post("/api/projects/LK/bugs", { title: "Баг кейса", severity: "minor", caseNum: k.data.num, runNum: run.data.num });
  await u.dev.post(`/api/projects/LK/cases/${k.data.num}/comments`, { text: "заметка" });
  await u.tester.patch(`/api/projects/LK/cases/${k.data.num}`, { title: "В корзину v2" });

  let r = await u.tester.del(`/api/projects/LK/cases/${k.data.num}`);
  assert.equal(r.status, 200);
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${k.data.num}`)).status, 404);
  let ps = await u.tester.get("/api/projects/LK/state");
  assert.equal(ps.data.bugs.find((b) => b.num === bug.data.num).caseNum, null, "ссылка бага на кейс снята");

  const trash = await u.tester.get("/api/projects/LK/trash");
  const item = trash.data.items.find((i) => i.ref === `LK-${k.data.num}`);
  assert.ok(item);
  assert.equal((await u.dev.post(`/api/projects/LK/trash/${item.id}/restore`)).status, 403);
  r = await u.tester.post(`/api/projects/LK/trash/${item.id}/restore`);
  assert.equal(r.status, 200);

  const full = await u.tester.get(`/api/projects/LK/cases/${k.data.num}`);
  assert.equal(full.data.title, "В корзину v2");
  assert.equal(full.data.steps, "шаг");
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${k.data.num}/versions`)).data.versions.length, 2);
  const rr = await u.tester.get(`/api/projects/LK/runs/${run.data.num}/results`);
  assert.equal(rr.data.results.find((x) => x.caseNum === k.data.num).comment, "упал");
  ps = await u.tester.get("/api/projects/LK/state");
  assert.equal(ps.data.bugs.find((b) => b.num === bug.data.num).caseNum, k.data.num, "ссылка бага вернулась");
  assert.ok(ps.data.comments.some((c) => c.caseNum === k.data.num && c.text === "заметка"));
  assert.equal(ps.data.results.find((x) => x.caseNum === k.data.num).result, "failed", "последний результат пересчитан");

  // баг и прогон
  await u.tester.del(`/api/projects/LK/bugs/${bug.data.num}`);
  await u.tester.del(`/api/projects/LK/runs/${run.data.num}`);
  const t2 = (await u.tester.get("/api/projects/LK/trash")).data.items;
  for (const ref of [`LK-B${bug.data.num}`, `LK-R${run.data.num}`]) {
    const it = t2.find((i) => i.ref === ref);
    assert.equal((await u.tester.post(`/api/projects/LK/trash/${it.id}/restore`)).status, 200, ref);
  }
  ps = await u.tester.get("/api/projects/LK/state");
  const back = ps.data.bugs.find((b) => b.num === bug.data.num);
  assert.equal(back.runNum, run.data.num, "баг снова ссылается на результат прогона");
  assert.equal((await u.tester.del(`/api/projects/LK/trash/1`)).status, 403, "навсегда удаляет только админ");
});

test("проект: удаляет только админ с подтверждением, проект исчезает и восстанавливается", async () => {
  await u.admin.post("/api/projects", { key: "DEL", name: "Удаляемый" });
  await u.admin.put("/api/admin/users/tester/projects", { projects: ["LK", "DEL"] });
  assert.equal((await u.tester.del("/api/projects/DEL", { confirm: "DEL" })).status, 403);
  assert.equal((await u.admin.del("/api/projects/DEL", {})).status, 400);
  assert.equal((await u.admin.del("/api/projects/DEL", { confirm: "DEL" })).status, 200);
  assert.equal((await u.tester.get("/api/projects/DEL/state")).status, 404);
  assert.equal((await u.admin.get("/api/projects/DEL/state")).status, 404, "и админу тоже");
  assert.ok(!(await u.admin.get("/api/state")).data.projects.some((p) => p.id === "DEL"));
  const r = await u.admin.post("/api/projects", { key: "DEL", name: "Новый" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /корзин/);
  const list = await u.admin.get("/api/admin/trash/projects");
  assert.ok(list.data.items.some((p) => p.key === "DEL"));
  assert.equal((await u.admin.post("/api/admin/projects/DEL/restore")).status, 200);
  assert.equal((await u.tester.get("/api/projects/DEL/state")).status, 200);
  assert.equal((await u.admin.del("/api/projects/DEL", { confirm: "DEL" })).status, 200);
  await u.admin.put("/api/admin/users/tester/projects", { projects: ["LK"] });
});

test("журнал аудита: входы, неудачи, роли и удаления; фильтр и CSV; только админ", async () => {
  await client(srv.base).post("/api/auth/login", { login: "dev", password: "wrong-pass" });
  await u.admin.patch("/api/admin/users/viewer", { role: "developer" });
  const k = await u.tester.post("/api/projects/LK/cases", { title: "Для аудита", priority: "low", status: "ready" });
  await u.tester.del(`/api/projects/LK/cases/${k.data.num}`);
  await new Promise((r) => setTimeout(r, 200));
  let r = await u.admin.get("/api/admin/audit?limit=200");
  const acts = r.data.items.map((e) => e.action);
  for (const a of ["auth.login", "auth.login_failed", "user.update", "case.delete", "user.projects"]) assert.ok(acts.includes(a), a);
  const failed = r.data.items.find((e) => e.action === "auth.login_failed" && e.target === "dev");
  assert.ok(failed, "неудачный вход виден с логином");
  r = await u.admin.get("/api/admin/audit?action=case.&project=LK");
  assert.ok(r.data.items.every((e) => e.action.startsWith("case.") && e.project === "LK"));
  assert.equal(r.data.items[0].actor, "tester");
  const csv = await fetch(srv.base + "/api/admin/audit.csv?actor=tester", { headers: { cookie: u.admin.cookie } });
  assert.match(await csv.text(), /Тест-кейс удалён в корзину/);
  assert.equal((await u.tester.get("/api/admin/audit")).status, 403);
  await u.admin.patch("/api/admin/users/viewer", { role: "viewer" });
});

test("структурные шаги: создание, правка текстом сохраняет ожидаемые результаты, версии", async () => {
  const stepList = [
    { action: "Открыть страницу входа", expected: "Форма входа" },
    { action: "Ввести логин и пароль", expected: "", data: "user / secret" },
    { action: "Нажать «Войти»", expected: "Открылся профиль" },
  ];
  let r = await u.tester.post("/api/projects/LK/cases", { title: "Структурные шаги", priority: "high", status: "ready", stepList, tags: ["smoke", "Вход", "smoke"] });
  const n = r.data.num;
  let c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.stepList.length, 3);
  assert.equal(c.stepList[1].data, "user / secret");
  assert.equal(c.steps, "Открыть страницу входа\nВвести логин и пароль\nНажать «Войти»");
  assert.deepEqual(c.tags, ["smoke", "Вход"]);
  // старый клиент шлёт steps текстом с теми же действиями — ожидаемые результаты шагов не теряются
  await u.tester.patch(`/api/projects/LK/cases/${n}`, { steps: c.steps, title: "Структурные шаги v2" });
  c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.stepList[2].expected, "Открылся профиль");
  // правка без шагов не трогает шаги
  await u.tester.patch(`/api/projects/LK/cases/${n}`, { priority: "low" });
  c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.stepList.length, 3);
  const v = (await u.tester.get(`/api/projects/LK/cases/${n}/versions`)).data.versions;
  assert.equal(v[v.length - 1].stepList[0].expected, "Форма входа");
  // теги — тоже содержимое: версия растёт
  r = await u.tester.patch(`/api/projects/LK/cases/${n}`, { tags: ["regress"] });
  assert.equal(r.data.version, 4);
});

test("результат по шагам: итог считается сам, вложение к шагу, баг-фильтры по тегам", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "По шагам", priority: "low", status: "ready", stepList: [{ action: "a" }, { action: "b" }, { action: "c" }], tags: ["шаги"] });
  const run = (await u.tester.post("/api/projects/LK/runs", { title: "Шаги", caseNums: [k.data.num] })).data.num;
  const mark = (body) => u.tester.patch(`/api/projects/LK/runs/${run}/results/${k.data.num}`, body);
  const res = async () => (await u.tester.get(`/api/projects/LK/runs/${run}/results`)).data.results[0];
  await mark({ step: 0, result: "passed" });
  assert.equal((await res()).result, "untested");
  await mark({ step: 1, result: "failed", actual: "кнопки нет" });
  let r = await res();
  assert.equal(r.result, "failed");
  assert.deepEqual(r.steps["1"], { result: "failed", actual: "кнопки нет" });
  await mark({ step: 1, result: "passed" });
  await mark({ step: 2, result: "passed" });
  r = await res();
  assert.equal(r.result, "passed");
  assert.equal(r.steps["1"].actual, "кнопки нет", "фактический результат шага сохраняется");
  assert.equal((await mark({ step: 7, result: "passed" })).status, 404);
  // можно и без шагов — итог целиком
  assert.equal((await mark({ result: "blocked" })).status, 200);
  // вложение к шагу
  const up = await fetch(`${srv.base}/api/projects/LK/runs/${run}/results/${k.data.num}/attachments?step=1`, {
    method: "POST", headers: { cookie: u.tester.cookie, "x-upload": "1", "content-type": "image/png", "x-filename": "step.png" }, body: Buffer.from("png"),
  });
  assert.equal(up.status, 201);
  const files = (await u.tester.get(`/api/projects/LK/runs/${run}/results`)).data.attachments;
  assert.equal(files.find((f) => f.name === "step.png").step, 1);

  const list = await u.tester.get("/api/projects/LK/cases?tag=" + encodeURIComponent("шаги") + "&count=1");
  assert.equal(list.data.total, 1);
  const plan = await u.tester.post("/api/projects/LK/plans", { title: "По тегу", mode: "dynamic", filter: { tags: ["шаги"] } });
  assert.equal((await u.tester.get(`/api/projects/LK/plans/${plan.data.num}/cases`)).data.cases.length, 1);
  const bug = await u.tester.post("/api/projects/LK/bugs", { title: "С тегом", severity: "minor", tags: ["ui"] });
  assert.equal((await u.tester.get("/api/projects/LK/bugs?tag=ui")).data.items[0].num, bug.data.num);
});

test("пользовательские поля: настройка, проверка значений, обязательность, фильтр", async () => {
  assert.equal((await u.dev.post("/api/projects/LK/fields", { entity: "case", name: "x", type: "text" })).status, 403);
  let r = await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "Компонент", type: "select", options: ["Оплата", "Вход"] });
  assert.equal(r.status, 201);
  const comp = r.data.id;
  const story = (await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "История", type: "url" })).data.id;
  const sp = (await u.tester.post("/api/projects/LK/fields", { entity: "bug", name: "Оценка", type: "number", required: true })).data.id;
  assert.equal((await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "Компонент", type: "text" })).status, 409);

  r = await u.tester.post("/api/projects/LK/cases", { title: "С полями", priority: "low", status: "ready", fields: { [comp]: "Доставка" } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /нет варианта/);
  r = await u.tester.post("/api/projects/LK/cases", { title: "С полями", priority: "low", status: "ready", fields: { [comp]: "Оплата", [story]: "ftp://x" } });
  assert.equal(r.status, 400);
  r = await u.tester.post("/api/projects/LK/cases", { title: "С полями", priority: "low", status: "ready", fields: { [comp]: "Оплата", [story]: "https://jira/PAY-1" } });
  assert.equal(r.status, 201);
  const n = r.data.num;
  await u.tester.patch(`/api/projects/LK/cases/${n}`, { title: "С полями v2" });
  const c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.fields[comp], "Оплата", "правка без fields не стирает значения");
  assert.equal((await u.tester.get(`/api/projects/LK/cases?field.${comp}=${encodeURIComponent("Оплата")}&count=1`)).data.total, 1);

  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: "Без оценки", severity: "minor" })).status, 400, "обязательное поле");
  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: "С оценкой", severity: "minor", fields: { [sp]: "3" } })).status, 201);
  const ps = (await u.tester.get("/api/projects/LK/state")).data;
  assert.ok(ps.customFields.some((f) => f.name === "Компонент"));
  await u.tester.patch(`/api/projects/LK/fields/${sp}`, { required: false });
});

test("CSV: теги и ожидаемые результаты шагов туда и обратно", async () => {
  const csv = "Название;Шаги;Ожидаемые результаты шагов;Теги\nCSV шаги;\"Открыть\nНажать\";\"Открылось\nНажалось\";\"api, csv\"\n";
  const r = await u.tester.post("/api/projects/LK/cases/import", { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const found = (await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("CSV шаги"))).data.items[0];
  assert.deepEqual(found.stepList.map((s) => s.expected), ["Открылось", "Нажалось"]);
  assert.deepEqual(found.tags, ["api", "csv"]);
  const raw = await fetch(srv.base + "/api/projects/LK/cases/export", { headers: { cookie: u.tester.cookie } });
  const text = await raw.text();
  assert.match(text, /Ожидаемые результаты шагов;Теги/);
  assert.match(text, /"Открылось\r?\nНажалось";api, csv/);
});

test("экспорт и импорт проекта переносят шаги, теги, поля и результаты шагов", async () => {
  const exp = await u.tester.get("/api/projects/LK/export");
  assert.equal(exp.status, 200);
  const r = await u.admin.post("/api/projects-import", { source: "testball", data: exp.data, key: "CPY" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const src = (await u.admin.get("/api/projects/LK/cases?q=" + encodeURIComponent("Структурные шаги"))).data.items[0];
  const dst = (await u.admin.get("/api/projects/CPY/cases?q=" + encodeURIComponent("Структурные шаги"))).data.items[0];
  assert.deepEqual(dst.stepList, src.stepList);
  assert.deepEqual(dst.tags, src.tags);
  const st = (await u.admin.get("/api/projects/CPY/state")).data;
  const comp = st.customFields.find((f) => f.name === "Компонент");
  assert.ok(comp);
  assert.ok(st.cases.some((c) => c.fields[comp.id] === "Оплата"));
  // требования и их связи с кейсами
  const reqs = (await u.admin.get("/api/projects/CPY/requirements")).data.items;
  const srcReqs = (await u.admin.get("/api/projects/LK/requirements")).data.items;
  assert.deepEqual(reqs.map((x) => [x.num, x.title, x.extRef, x.cases.length]), srcReqs.map((x) => [x.num, x.title, x.extRef, x.cases.length]));
  assert.ok(reqs.length >= 2);
});

test("allure-results: шаги, повторы, параметры, вложения и связь с кейсом через report.js", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const kase = await u.tester.post("/api/projects/LK/cases", { title: "Вход для Allure", priority: "high", status: "ready" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allure-"));
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === "string" ? obj : JSON.stringify(obj));
  const base = { labels: [{ name: "suite", value: "auth" }, { name: "parentSuite", value: "web" }], start: 1000, stop: 1500 };
  w("a1-result.json", { ...base, uuid: "a1", historyId: "h1", name: "Вход по паролю", status: "passed",
    labels: [...base.labels, { name: "testball", value: `LK-${kase.data.num}` }, { name: "tag", value: "smoke" }],
    steps: [{ name: "Открыть страницу", status: "passed", start: 1000, stop: 1100, steps: [] }] });
  w("a2-result.json", { ...base, uuid: "a2", historyId: "h2", name: "Оплата", status: "failed",
    statusDetails: { message: "expected 200 got 500", trace: "at pay.spec.ts:10" },
    steps: [{ name: "Нажать оплатить", status: "failed", statusDetails: { message: "500" }, attachments: [{ name: "screen", source: "s1-attachment.png", type: "image/png" }] }] });
  w("s1-attachment.png", "PNGDATA");
  // повторы: сначала упал, потом прошёл
  w("a3-result.json", { ...base, uuid: "a3", historyId: "h3", name: "Нестабильный", status: "failed", start: 1, stop: 2 });
  w("a4-result.json", { ...base, uuid: "a4", historyId: "h3", name: "Нестабильный", status: "passed", start: 3, stop: 4 });
  // параметризованный
  w("a5-result.json", { ...base, uuid: "a5", historyId: "h5", name: "Логин", status: "passed", parameters: [{ name: "role", value: "admin" }] });
  w("a6-result.json", { ...base, uuid: "a6", historyId: "h6", name: "Логин", status: "unknown", parameters: [{ name: "role", value: "guest" }] });
  w("broken-result.json", "{не json");
  w("c1-container.json", { uuid: "c1", children: ["a1"] });

  const tok = (await u.tester.post("/api/tokens", { name: "allure", project: "LK" })).data.token;
  const r = spawnSync(process.execPath, ["scripts/report.js", dir, "--title", "Allure CI", "--build", "b42"], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, TESTBALL_URL: srv.base, TESTBALL_TOKEN: tok, TESTBALL_PROJECT: "LK" }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const st = (await u.tester.get("/api/projects/LK/state")).data;
  const run = st.autoruns.find((a) => a.title === "Allure CI");
  assert.deepEqual(run.counts, { passed: 3, failed: 1, broken: 1, skipped: 0 });
  assert.equal(run.state, "finished");
  const det = (await u.tester.get(`/api/projects/LK/autoruns/${run.num}`)).data;
  const byName = (n) => det.results.find((x) => x.name === n);
  assert.equal(byName("Оплата").message, "expected 200 got 500");
  assert.equal(byName("Оплата").steps[0].status, "failed");
  assert.equal(byName("Оплата").suite, "web › auth");
  assert.ok(byName("Логин [role=admin]") && byName("Логин [role=guest]").status === "broken");
  assert.ok(det.attachments.some((a) => a.autoResultId === byName("Оплата").id && a.name.startsWith("screen")));
  const tests = (await u.tester.get("/api/projects/LK/autotests")).data.tests;
  assert.equal(tests.find((t) => t.name === "Вход по паролю").caseNum, kase.data.num, "связь с кейсом по метке");
  const flakyRes = (await u.tester.get(`/api/projects/LK/autoruns/${run.num}`)).data.results.find((x) => x.name === "Нестабильный");
  assert.equal(flakyRes.status, "passed");
  assert.ok(flakyRes.flaky || flakyRes.retries >= 1);
});

test("Selenium: отчёты TestNG и NUnit — статусы, повторы, параметры, скриншоты, связь с кейсами", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const k1 = await u.tester.post("/api/projects/LK/cases", { title: "Selenium: вход по паролю", priority: "high", status: "ready" });
  const k2 = await u.tester.post("/api/projects/LK/cases", { title: "Selenium: поиск товара", priority: "high", status: "ready" });
  const src = path.join(__dirname, "fixtures", "selenium");
  // папка как у Maven Surefire: testng-results.xml + те же тесты в JUnit-формате + testng-failed.xml
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surefire-"));
  fs.writeFileSync(path.join(dir, "testng-results.xml"), fs.readFileSync(path.join(src, "testng-results.xml"), "utf8").replace("LK-CASE", `LK-${k1.data.num}`));
  fs.writeFileSync(path.join(dir, "TEST-TestSuite.xml"), '<testsuite name="TestSuite"><testcase classname="com.shop.ui.LoginTest" name="loginByPassword"/></testsuite>');
  fs.writeFileSync(path.join(dir, "testng-failed.xml"), '<suite name="Failed suite"><test name="x"><classes/></test></suite>');
  fs.cpSync(path.join(src, "screens"), path.join(dir, "screens"), { recursive: true });
  const nunit = path.join(dir, "nunit");
  fs.mkdirSync(nunit);
  fs.writeFileSync(path.join(nunit, "TestResult.xml"), fs.readFileSync(path.join(src, "TestResult.xml"), "utf8").replace("LK-CASE", `LK-${k2.data.num}`));
  fs.cpSync(path.join(src, "screens"), path.join(nunit, "screens"), { recursive: true });

  const tok = (await u.tester.post("/api/tokens", { name: "selenium", project: "LK" })).data.token;
  const env = { ...process.env, TESTBALL_URL: srv.base, TESTBALL_TOKEN: tok, TESTBALL_PROJECT: "LK" };
  const send = (target, title) => spawnSync(process.execPath, ["scripts/report.js", target, "--title", title], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
  let r = send(dir, "Selenium TestNG");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = send(path.join(nunit, "TestResult.xml"), "Selenium NUnit");
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const st = (await u.tester.get("/api/projects/LK/state")).data;
  const tng = st.autoruns.find((a) => a.title === "Selenium TestNG");
  assert.deepEqual(tng.counts, { passed: 3, failed: 1, broken: 1, skipped: 1 }, "testng-results.xml без задвоения из TEST-*.xml, настройка setUp не считается тестом");
  const det = (await u.tester.get(`/api/projects/LK/autoruns/${tng.num}`)).data;
  const by = (n) => det.results.find((x) => x.name.startsWith(n));
  assert.equal(by("loginWrongPassword").status, "failed");
  assert.match(by("loginWrongPassword").message, /Неверный пароль/);
  assert.equal(by("openProfile").status, "broken", "исключение Selenium — сломанный тест, не упавшая проверка");
  assert.ok(by("addToCart").flaky || by("addToCart").retries >= 1, "повтор через RetryAnalyzer");
  assert.ok(by("search [ноутбук]"), "параметры DataProvider в названии");
  assert.equal(by("checkout").status, "skipped");
  assert.ok(det.attachments.some((a) => a.autoResultId === by("loginWrongPassword").id), "скриншот из Reporter.log");

  const nu = st.autoruns.find((a) => a.title === "Selenium NUnit");
  assert.deepEqual(nu.counts, { passed: 2, failed: 0, broken: 1, skipped: 1 });
  const ndet = (await u.tester.get(`/api/projects/LK/autoruns/${nu.num}`)).data;
  const empty = ndet.results.find((x) => x.name === "SearchEmpty");
  assert.match(empty.message, /WebDriverTimeoutException/);
  assert.ok(ndet.attachments.some((a) => a.autoResultId === empty.id), "вложение из <attachments>");

  const tests = (await u.tester.get("/api/projects/LK/autotests")).data.tests;
  assert.equal(tests.find((t) => t.name.startsWith("loginByPassword")).caseNum, k1.data.num, "TestNG: номер кейса из description");
  assert.equal(tests.find((t) => t.name.startsWith("SearchByName")).caseNum, k2.data.num, "NUnit: номер кейса из Description");

  // pytest + Selenium: JUnit XML, номер кейса через record_property("testball", …); посторонние свойства не считаются номером
  const k3 = await u.tester.post("/api/projects/LK/cases", { title: "Selenium: корзина на Python", priority: "high", status: "ready" });
  const py = path.join(dir, "junit-py.xml");
  fs.writeFileSync(py, `<testsuites><testsuite name="pytest"><testcase classname="tests.test_cart" name="test_cart" time="1.2"><properties><property name="testball" value="LK-${k3.data.num}"/><property name="encoding" value="UTF-8"/></properties></testcase></testsuite></testsuites>`);
  r = send(py, "Selenium pytest");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t3 = (await u.tester.get("/api/projects/LK/autotests")).data.tests.find((t) => t.name.startsWith("test_cart"));
  assert.equal(t3.caseNum, k3.data.num, "pytest: record_property");
  assert.ok(!t3.name.includes("UTF-8"));
});

test("отчёты по прогону и плану: PDF и Excel", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "Для отчёта: оплата картой", priority: "high", status: "ready", stepList: [{ action: "Открыть" }, { action: "Оплатить", expected: "Успех" }] });
  const run = (await u.tester.post("/api/projects/LK/runs", { title: "Отчётный прогон", build: "3.1", caseNums: [k.data.num] })).data.num;
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${k.data.num}`, { step: 1, result: "failed", actual: "Ошибка 500" });
  await u.tester.post("/api/projects/LK/bugs", { title: "Оплата падает", severity: "critical", caseNum: k.data.num, runNum: run });
  const get = (url) => fetch(srv.base + url, { headers: { cookie: u.dev.cookie } });
  let r = await get(`/api/projects/LK/runs/${run}/report?format=pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /filename\*=UTF-8''LK-R\d+-/);
  const pdfBuf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdfBuf.length > 5000);
  r = await get(`/api/projects/LK/runs/${run}/report?format=xlsx`);
  assert.equal(r.status, 200);
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const res = wb.getWorksheet("Результаты");
  assert.equal(res.getRow(2).getCell(4).value, "Упал");
  assert.match(String(res.getRow(2).getCell(5).value), /2\. Оплатить — Ошибка 500/);
  assert.equal(wb.getWorksheet("Баги").getRow(2).getCell(3).value, "Критический");
  const plan = (await u.tester.post("/api/projects/LK/plans", { title: "План отчёта", mode: "static", caseNums: [k.data.num] })).data.num;
  await u.tester.post(`/api/projects/LK/plans/${plan}/runs`, { title: "Из плана" });
  r = await get(`/api/projects/LK/plans/${plan}/report?format=pdf`);
  assert.equal(r.status, 200);
  assert.equal((await get(`/api/projects/LK/runs/99999/report`)).status, 404);
});
