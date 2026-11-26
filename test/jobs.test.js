// Очередь фоновых задач: доставка вебхуков с повторами, упавшие задачи, зависшие задачи после падения сервера
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client } = require("pg");
const { startServer, seed } = require("./helpers");

let srv, u, receiver, port;
const got = [];
let answer = [500, 200]; // коды ответа приёмника по очереди; дальше — последний
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const sql = async (q, p) => {
  const c = new Client({ connectionString: srv.dbUrl });
  await c.connect();
  try {
    return (await c.query(q, p)).rows;
  } finally {
    await c.end();
  }
};

test.before(async () => {
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ event: req.headers["x-testball-event"], body: JSON.parse(body || "{}") });
      res.statusCode = answer.length > 1 ? answer.shift() : answer[0];
      res.end("ok");
    });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  port = receiver.address().port;
  srv = await startServer({ JOB_POLL_MS: "100", WEBHOOK_RETRIES: "200,200,200" });
  u = await seed(srv);
});
test.after(async () => {
  receiver?.close();
  await srv?.stop();
});

test("вебхук доставляется через очередь и повторяется после 500", async () => {
  const hook = await u.tester.post("/api/projects/LK/webhooks", { name: "Приёмник", url: `http://127.0.0.1:${port}/hook`, events: ["bug.created"] });
  assert.equal(hook.status, 201, JSON.stringify(hook.data));
  await u.tester.post("/api/projects/LK/bugs", { title: "Падает оплата", severity: "major" });
  await until(() => got.filter((g) => g.event === "bug.created").length >= 2);
  const deliveries = await sql("SELECT attempt, status FROM webhook_deliveries ORDER BY id");
  assert.deepEqual(deliveries.map((d) => [d.attempt, d.status]), [[1, 500], [2, 200]]);
  assert.equal(got.at(-1).body.bug.title, "Падает оплата");
  const jobs = await sql("SELECT status, attempts FROM jobs WHERE kind='webhook.deliver'");
  assert.deepEqual(jobs.map((j) => [j.status, j.attempts]), [["done", 2]]);
});

test("ошибка настройки (4xx) — задача падает сразу, видна администратору, повтор доставляет", async () => {
  answer = [404];
  got.length = 0;
  await u.tester.post("/api/projects/LK/bugs", { title: "Второй баг", severity: "minor" });
  const failed = await until(async () => (await u.admin.get("/api/admin/jobs")).data.failed.find((j) => j.kind === "webhook.deliver"));
  assert.equal(failed.attempts, 1, "4xx не повторяется");
  assert.match(failed.error, /Приёмник: HTTP 404/);
  assert.equal(failed.title, "Доставка вебхука");
  assert.equal((await u.tester.get("/api/admin/jobs")).status, 403);
  answer = [200];
  assert.equal((await u.admin.post(`/api/admin/jobs/${failed.id}/retry`)).status, 200);
  await until(() => got.some((g) => g.body.bug?.title === "Второй баг" && answer[0] === 200) && got.length >= 2);
  await until(async () => (await sql("SELECT status FROM jobs WHERE id=$1", [failed.id]))[0].status === "done");
  assert.equal((await u.admin.post(`/api/admin/jobs/${failed.id}/retry`)).status, 404, "выполненную повторять нечего");
});

test("задача, зависшая на упавшем сервере, выполняется снова; периодические задачи стоят в расписании", async () => {
  // сервер «упал» посреди уборки: задача осталась running с истёкшей блокировкой
  const [j] = await sql("INSERT INTO jobs(kind, status, attempts, locked_until) VALUES ('housekeeping', 'running', 1, now() - interval '1 minute') RETURNING id");
  await until(async () => (await sql("SELECT status FROM jobs WHERE id=$1", [j.id]))[0].status === "done");
  const kinds = (await sql("SELECT kind FROM job_schedule ORDER BY kind")).map((r) => r.kind);
  assert.deepEqual(kinds, ["analytics.precompute", "attachments.sweep", "autoruns.expire", "housekeeping", "tracker.sync"]);
  const overview = (await u.admin.get("/api/admin/jobs")).data;
  assert.ok(overview.kinds.find((k) => k.kind === "housekeeping").every > 0);
});

test("срок блокировки зависит от типа задачи, продлевается и защищает результат новой попытки", async (t) => {
  // Собственные обработчики используют ту же PostgreSQL, сервер не захватывает незнакомые типы.
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = srv.dbUrl;
  const jobs = require("../server/jobs");
  const { pool } = require("../server/db");
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;

  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  t.after(async () => {
    release();
    await jobs.stop();
    await pool.end();
  });
  jobs.define("test.short", async (_payload, { attempt }) => {
    if (attempt === 1) {
      await paused;
      throw jobs.permanent("Запоздавшая ошибка первой попытки");
    }
  }, { timeoutMs: 900 });
  jobs.define("test.long", () => paused, { timeoutMs: 6 * 3600e3 });

  const short = await jobs.enqueue("test.short");
  const long = await jobs.enqueue("test.long");
  const state = async (id) => (await sql(`SELECT status, attempts, worker, last_error,
    extract(epoch FROM locked_until - started_at)::float AS lease FROM jobs WHERE id=$1`, [id]))[0];
  const first = await until(async () => {
    const row = await state(short);
    return row.status === "running" && row;
  });
  const backup = await until(async () => {
    const row = await state(long);
    return row.status === "running" && row;
  });
  assert.ok(first.lease < 2, "у короткой задачи собственный срок, даже при наличии долгого обработчика");
  assert.equal(backup.lease, 6 * 3600);

  await until(async () => (await state(short)).lease > first.lease + 0.9);
  await jobs.tick();
  assert.equal((await state(short)).attempts, 1, "работающую задачу не забирают повторно");

  await sql("UPDATE jobs SET locked_until=now() - interval '1 second' WHERE id=$1", [short]);
  await jobs.tick();
  const second = await until(async () => {
    const row = await state(short);
    return row.status === "done" && row;
  });
  assert.equal(second.attempts, 2);
  assert.notEqual(second.worker, first.worker);
  release();
  await jobs.stop();
  assert.deepEqual(await state(short), second, "запоздалая первая попытка не меняет итог новой");
});
