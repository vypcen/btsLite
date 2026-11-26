const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { test, before, after } = require("node:test");
const { Client } = require("pg");
const { seed, startServer } = require("./helpers");

let srv, users;
before(async () => {
  srv = await startServer({ IMPORT_MAX_MB: "8", EXPORT_MAX_FILES_MB: "8" });
  users = await seed(srv);
});
after(async () => srv && srv.stop());

test("экспорт проекта не выдаёт неполную копию как успешную", async () => {
  const base = "/api/projects/LK";
  const created = await users.tester.post(base + "/cases", { title: "Кейс с вложением", priority: "medium", status: "ready" });
  assert.equal(created.status, 201);
  const upload = await users.tester.post(base + `/cases/${created.data.num}/attachments`, Buffer.from("sample"), {
    "x-upload": "1", "x-filename": "sample.txt", "content-type": "text/plain",
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const file = path.join(os.tmpdir(), srv.db, upload.data.id);
  const exported = await users.admin.get(base + "/export?files=1");
  assert.equal(exported.status, 200);
  exported.data.attachments[upload.data.id].data = "";
  const invalid = await users.admin.post("/api/projects-import", { source: "testball", data: exported.data, key: "CORRUP", dryRun: true });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /sample\.txt/);
  await fs.rename(file, file + ".held");
  try {
    const incomplete = await users.admin.get(base + "/export?files=1");
    assert.equal(incomplete.status, 409);
    assert.match(incomplete.data.error, /sample\.txt/);
    assert.equal((await users.admin.get(base + "/export")).status, 200);
  } finally {
    await fs.rename(file + ".held", file);
  }
});

test("незавершённые прогоны CI выходят из очереди после тайм-аута", async () => {
  const base = "/api/projects/LK";
  const nums = [];
  for (const title of ["Давно в очереди", "Давно ожидал результаты", "Текущий запуск"]) {
    const run = await users.tester.post(base + "/autoruns", { title });
    assert.equal(run.status, 201);
    nums.push(run.data.num);
  }
  const db = new Client({ connectionString: srv.dbUrl });
  await db.connect();
  try {
    await db.query("UPDATE auto_runs SET state='queued', last_activity_at=now()-interval '2 hours' WHERE project_key='LK' AND num=$1", [nums[0]]);
    await db.query("UPDATE auto_runs SET state='running', last_activity_at=now()-interval '7 hours' WHERE project_key='LK' AND num=$1", [nums[1]]);
    await db.query("UPDATE auto_runs SET state='running', last_activity_at=now()-interval '7 hours' WHERE project_key='LK' AND num=$1", [nums[2]]);
    assert.equal((await users.tester.post(base + `/autoruns/${nums[2]}/results`, { results: [{ name: "Продолжается", status: "passed" }] })).status, 200);
    const env = { ...process.env, DATABASE_URL: srv.dbUrl, CI_QUEUE_TIMEOUT_MINUTES: "60", CI_IDLE_TIMEOUT_MINUTES: "360" };
    const code = 'const {pool}=require("./server/db");require("./server/autotests").expireInactive().then(n=>{if(n!==2)process.exitCode=1}).finally(()=>pool.end())';
    await promisify(execFile)(process.execPath, ["-e", code], { cwd: path.join(__dirname, ".."), env });
    const { data } = await users.tester.get(base + "/state?parts=autoruns");
    const runs = nums.map((n) => data.autoruns.find((r) => r.num === n));
    assert.deepEqual(runs.map((r) => r.state), ["failed", "failed", "running"]);
    assert.match(runs[0].failureReason, /не начал/);
    assert.match(runs[1].failureReason, /перестал/);
  } finally {
    await db.end();
  }
});

test("репортёр привязанного CI-прогона возвращает ошибку доставки", async () => {
  const Reporter = require("../scripts/playwright-reporter");
  const reporter = new Reporter({ url: srv.base, token: "invalid-ci-token", project: "LK", run: 1 });
  reporter.onBegin({ rootDir: __dirname }, { suites: [], allTests: () => [] });
  assert.deepEqual(await reporter.onEnd(), { status: "failed" });
});

test("JSON-вложение автотеста сохраняется и переносится с исходными байтами", async () => {
  const base = "/api/projects/LK";
  const run = await users.tester.post(base + "/autoruns", { title: "Проверка JSON-вложения" });
  assert.equal(run.status, 201);
  const runPath = base + "/autoruns/" + run.data.num;
  const result = await users.tester.post(runPath + "/results", { results: [{ name: "Платёж", status: "failed" }] });
  assert.equal(result.status, 200);
  const route = runPath + "/results/" + result.data.ids[0] + "/attachments";
  const json = Buffer.from('{"state":"paid","amount":99}\n');
  const headers = { "x-upload": "1", "x-filename": "checkout.json", "content-type": "application/json" };
  assert.equal((await users.tester.post(route, json, { "content-type": "application/json" })).status, 400);
  const upload = await users.tester.post(route, json, headers);
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const retrieved = await fetch(srv.base + "/api/attachments/" + upload.data.id, { headers: { cookie: users.tester.cookie } });
  assert.equal(retrieved.status, 200);
  assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), json);

  const failed = await users.tester.patch(runPath, { state: "failed", failureReason: "Отчёт прервался" });
  assert.equal(failed.status, 200);
  const exported = await users.admin.get(base + "/export?files=1");
  assert.equal(exported.status, 200, JSON.stringify(exported.data).slice(0, 200));
  const copied = await users.admin.post("/api/projects-import", { source: "testball", data: exported.data, key: "ACOPY" });
  assert.equal(copied.status, 201);
  const copy = await users.admin.get("/api/projects/ACOPY/autoruns/" + run.data.num);
  assert.equal(copy.status, 200);
  assert.equal(copy.data.attachments.length, 1);
  const imported = await fetch(srv.base + "/api/attachments/" + copy.data.attachments[0].id, { headers: { cookie: users.admin.cookie } });
  assert.deepEqual(Buffer.from(await imported.arrayBuffer()), json);
  const state = await users.admin.get("/api/projects/ACOPY/state?parts=autoruns");
  assert.equal(state.data.autoruns.find((a) => a.num === run.data.num).failureReason, "Отчёт прервался");
  assert.equal((await users.admin.del("/api/projects/ACOPY", { confirm: "ACOPY" })).status, 200);
});

test("экспорт учитывает рост размера при кодировании файлов и лимит запроса импорта", async () => {
  const base = "/api/projects/LK";
  const { data } = await users.tester.post(base + "/cases", { title: "Размер архива", priority: "medium", status: "ready" });
  const upload = (i) => users.tester.post(base + `/cases/${data.num}/attachments`, Buffer.alloc(3.5 * 1024 * 1024, 65 + i), {
    "x-upload": "1", "x-filename": `size-${i}.txt`, "content-type": "text/plain",
  });
  assert.equal((await upload(0)).status, 201);
  const second = await upload(1);
  assert.equal(second.status, 201);
  const oversize = await users.admin.get(base + "/export?files=1");
  assert.equal(oversize.status, 413);
  assert.match(oversize.data.error, /IMPORT_MAX_MB/);
  assert.equal((await users.admin.get(base + "/export")).status, 200);

  assert.equal((await users.tester.del("/api/attachments/" + second.data.id)).status, 200);
  const exported = await users.admin.get(base + "/export?files=1");
  assert.equal(exported.status, 200);
  const imported = await users.admin.post("/api/projects-import", { source: "testball", data: exported.data, key: "SIZEX", name: "Проверка размера" });
  assert.equal(imported.status, 201);
  assert.equal((await users.admin.del("/api/projects/SIZEX", { confirm: "SIZEX" })).status, 200);
});

test("перенос корректно обрабатывает удалённые папки динамических планов", async () => {
  const base = "/api/projects/LK";
  const checked = async (request, status = 200) => {
    const result = await request;
    assert.equal(result.status, status, JSON.stringify(result.data).slice(0, 400));
    return result.data;
  };
  const gone = await checked(users.tester.post(base + "/folders", { name: "Удаляемая папка" }), 201);
  const live = await checked(users.tester.post(base + "/folders", { name: "Остающаяся папка" }), 201);
  const kase = await checked(users.tester.post(base + "/cases", { title: "Перенос фильтра", priority: "high", status: "ready", folder: live.id }), 201);
  const makePlan = (title, folders) => checked(users.tester.post(base + "/plans", {
    title, mode: "dynamic", filter: { folders },
  }), 201);
  const mixed = await makePlan("Обе папки", [gone.id, live.id]);
  const empty = await makePlan("Только удаляемая папка", [gone.id]);
  await checked(users.tester.del(base + "/folders/" + gone.id));
  const snapshot = await checked(users.admin.get(base + "/export"));
  const payload = { source: "testball", data: snapshot, key: "FLDRCP" };
  await checked(users.admin.post("/api/projects-import", payload), 201);

  const copy = "/api/projects/FLDRCP";
  const present = await checked(users.admin.get(copy + "/plans/" + mixed.num + "/cases"));
  assert.deepEqual(present.cases.map((c) => c.num), [kase.num]);
  const missing = await checked(users.admin.get(copy + "/plans/" + empty.num + "/cases"));
  assert.deepEqual(missing.cases, []);
  const plans = await checked(users.admin.get(copy + "/plans"));
  const f = plans.plans.find((p) => p.num === empty.num).filter;
  assert.equal(f.emptyFolders, true);
  const preview = await checked(users.admin.post(copy + "/plans/preview", { filter: f }));
  assert.deepEqual(preview.caseNums, []);
});
