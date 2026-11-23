// Копирование кейсов: в ту же папку, в другую папку, в другой проект (общие шаги, набор данных, поля, права)
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
  await u.admin.post("/api/projects", { key: "MB", name: "Мобильное приложение" });
});
test.after(async () => srv && (await srv.stop()));

const P = "/api/projects/LK";
const kase = async (c, num) => (await c.get(`${P}/cases/${num}`)).data;

test("копия в той же папке: новый номер, «(копия)», шаги, теги, поля и параметры", async () => {
  const f = (await u.tester.post(`${P}/folders`, { name: "Вход" })).data.id;
  const fld = (await u.admin.post(`${P}/fields`, { entity: "case", name: "Компонент", type: "select", options: ["Веб", "API"] })).data.id;
  const src = (await u.tester.post(`${P}/cases`, {
    title: "Вход по паролю", priority: "high", status: "ready", folder: f, tags: ["smoke"], fields: { [fld]: "Веб" },
    stepList: [{ action: "Открыть {{url}}", expected: "Форма" }], params: { columns: ["url"], rows: [{ name: "прод", values: { url: "/login" } }] },
  })).data;
  const r = await u.tester.post(`${P}/cases/copy`, { nums: [src.num] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.created.length, 1);
  const c = await kase(u.tester, r.data.created[0].num);
  assert.notEqual(c.num, src.num);
  assert.equal(c.title, "Вход по паролю (копия)");
  assert.equal(c.folder, f);
  assert.deepEqual(c.tags, ["smoke"]);
  assert.equal(c.fields[fld], "Веб");
  assert.equal(c.stepList[0].action, "Открыть {{url}}");
  assert.equal(c.params.rows[0].values.url, "/login");
  assert.equal(c.version, 1);

  // в другую папку проекта
  const f2 = (await u.tester.post(`${P}/folders`, { name: "Архив" })).data.id;
  const r2 = await u.tester.post(`${P}/cases/copy`, { nums: [src.num, c.num], folder: f2 });
  assert.equal(r2.data.created.length, 2);
  for (const x of r2.data.created) assert.equal((await kase(u.tester, x.num)).folder, f2);
});

test("копия в другой проект: общие шаги раскрываются, поля — по названию и типу, нужен доступ к проекту", async () => {
  const sh = (await u.tester.post(`${P}/shared-steps`, { title: "Войти", stepList: [{ action: "Ввести логин", expected: "Ок" }, { action: "Нажать «Войти»" }] })).data;
  const ds = (await u.tester.post(`${P}/datasets`, { name: "Браузеры", columns: ["browser"], rows: [{ name: "Chrome", values: { browser: "chrome" } }] })).data;
  const fld = (await u.admin.post(`${P}/fields`, { entity: "case", name: "Риск", type: "text" })).data.id;
  const other = (await u.admin.post(`/api/projects/MB/fields`, { entity: "case", name: "риск", type: "text" })).data.id;
  const src = (await u.tester.post(`${P}/cases`, {
    title: "Оформление заказа", priority: "medium", status: "ready", fields: { [fld]: "высокий" }, dataset: ds.id,
    stepList: [{ shared: sh.id }, { action: "Оплатить", expected: "Заказ создан" }],
  })).data;

  // tester не участник MB
  let r = await u.tester.post(`${P}/cases/copy`, { nums: [src.num], project: "MB" });
  assert.equal(r.status, 404);
  await u.admin.put("/api/admin/users/tester/projects", { projects: ["LK", "MB"] });
  r = await u.tester.post(`${P}/cases/copy`, { nums: [src.num], project: "MB" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(JSON.parse(r.headers.get("x-testball-changes")), [{ type: "cases", pid: "MB" }]);
  assert.equal(r.data.project, "MB");
  assert.equal(r.data.expanded, 1);
  const c = (await u.tester.get(`/api/projects/MB/cases/${r.data.created[0].num}`)).data;
  assert.equal(c.title, "Оформление заказа", "в другой проект — без «(копия)»");
  assert.equal(c.folder, null);
  assert.deepEqual(c.stepList.map((s) => s.action), ["Ввести логин", "Нажать «Войти»", "Оплатить"]);
  assert.equal(c.fields[other], "высокий");
  assert.ok(!c.dataset, "набор данных проекта не переносится ссылкой");
  assert.equal(c.params.rows[0].values.browser, "chrome");

  // разработчик (только чтение) копировать не может
  assert.equal((await u.dev.post(`${P}/cases/copy`, { nums: [src.num] })).status, 403);
});
