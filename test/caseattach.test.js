// Вложения тест-кейсов: загрузка (к кейсу и к шагу), права, выдача с кейсом, удаление, корзина, копирование, экспорт/импорт проекта
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && (await srv.stop()));

const P = "/api/projects/LK";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const up = (c, num, buf, name, step) => c.post(`${P}/cases/${num}/attachments${step === undefined ? "" : `?step=${step}`}`, buf,
  { "x-upload": "1", "content-type": name.endsWith(".png") ? "image/png" : "text/plain", "x-filename": encodeURIComponent(name) });
const full = async (c, num, key = "LK") => (await c.get(`/api/projects/${key}/cases/${num}`)).data;

test("вложения кейса: загрузка, к шагу, права, выдача, скачивание, удаление", async () => {
  const k = (await u.tester.post(`${P}/cases`, { title: "Макет экрана входа", priority: "high", status: "ready", stepList: [{ action: "Открыть" }, { action: "Сверить с макетом" }] })).data;
  let r = await up(u.tester, k.num, PNG, "макет.png");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const caseFile = r.data.id;
  r = await up(u.tester, k.num, Buffer.from("логин;пароль"), "данные.csv", 1);
  assert.equal(r.status, 201);
  // разработчик (только чтение) загрузить не может, но видит и скачивает
  assert.equal((await up(u.dev, k.num, PNG, "x.png")).status, 403);
  const c = await full(u.dev, k.num);
  assert.deepEqual(c.attachments.map((a) => [a.name, a.step, a.caseNum]), [["макет.png", null, k.num], ["данные.csv", 1, k.num]]);
  const dl = await u.dev.raw("GET", `/api/attachments/${caseFile}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "image/png");
  // посторонний не видит файл чужого проекта
  assert.equal((await u.outsider.raw("GET", `/api/attachments/${caseFile}`)).status, 404);
  // удалить: разработчик нет, тестировщик да
  assert.equal((await u.dev.del(`/api/attachments/${caseFile}`)).status, 404);
  assert.equal((await u.tester.del(`/api/attachments/${caseFile}`)).status, 200);
  assert.equal((await full(u.tester, k.num)).attachments.length, 1);
  assert.equal((await up(u.tester, 9999, PNG, "x.png")).status, 404);
  assert.equal((await up(u.tester, k.num, PNG, "x.png", -1)).status, 400);
});

test("корзина возвращает кейс с вложениями; копия получает свои файлы", async () => {
  const k = (await u.tester.post(`${P}/cases`, { title: "Кейс с файлом", priority: "medium", status: "ready" })).data;
  const fid = (await up(u.tester, k.num, PNG, "скрин.png")).data.id;

  const copy = (await u.tester.post(`${P}/cases/copy`, { nums: [k.num] })).data.created[0];
  const cf = (await full(u.tester, copy.num)).attachments;
  assert.equal(cf.length, 1);
  assert.notEqual(cf[0].id, fid, "у копии свой файл");
  assert.equal((await u.tester.raw("GET", `/api/attachments/${cf[0].id}`)).status, 200);

  const del = await u.tester.del(`${P}/cases/${k.num}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal((await u.tester.raw("GET", `/api/attachments/${fid}`)).status, 404);
  // файл копии не пострадал
  assert.equal((await u.tester.raw("GET", `/api/attachments/${cf[0].id}`)).status, 200);
  const trash = (await u.tester.get(`${P}/trash`)).data.items.find((x) => x.kind === "case" && x.num === k.num);
  assert.equal((await u.tester.post(`${P}/trash/${trash.id}/restore`, {})).status, 200);
  const back = await full(u.tester, k.num);
  assert.deepEqual(back.attachments.map((a) => a.id), [fid]);
  assert.equal((await u.tester.raw("GET", `/api/attachments/${fid}`)).status, 200);
});

test("экспорт и импорт проекта переносят вложения кейсов с номером шага", async () => {
  const k = (await u.tester.post(`${P}/cases`, { title: "Экспорт с файлами", priority: "medium", status: "ready", stepList: [{ action: "Шаг" }] })).data;
  await up(u.tester, k.num, PNG, "к шагу.png", 0);
  const exp = (await u.admin.get(`${P}/export?files=1`)).data;
  const ec = exp.cases.find((c) => c.num === k.num);
  assert.equal(ec.attachments.length, 1);
  assert.equal(exp.attachments[ec.attachments[0]].step, 0);
  const r = await u.admin.post("/api/projects-import", { source: "testball", data: exp, key: "LKC" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const c = await full(u.admin, k.num, "LKC");
  assert.deepEqual(c.attachments.map((a) => [a.name, a.step]), [["к шагу.png", 0]]);
  const dl = await u.admin.raw("GET", `/api/attachments/${c.attachments[0].id}`);
  assert.equal(dl.status, 200);
  assert.ok(String(dl.data).length > 0, "файл перенесён с содержимым");
});
