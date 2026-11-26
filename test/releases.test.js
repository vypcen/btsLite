const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

test("релиз Community: простая карточка и связь с прогоном, без спринтов и готовности", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { tester } = await seed(srv);
  const p = "/api/projects/LK";
  const made = await tester.post(p + "/releases", { name: "Релиз 1" });
  assert.equal(made.status, 201);
  const rel = made.data.num;
  assert.equal((await tester.post(p + "/releases", { name: "Спринт", parent: rel })).status, 400);
  const details = await tester.get(p + "/releases/" + rel);
  assert.equal(details.data.name, "Релиз 1");
  assert.equal(details.data.ready, undefined);
  const c = await tester.post(p + "/cases", { title: "Дымовой тест", status: "ready", priority: "low" });
  const run = await tester.post(p + "/runs", { title: "Регресс", release: rel, caseNums: [c.data.num] });
  assert.equal(run.status, 201);
  assert.equal((await tester.get(p + "/state")).data.runs.find((r) => r.num === run.data.num).release, rel);
});

test("даты релиза сохраняются при редактировании описания и при переносе", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const u = await seed(srv);
  const P = "/api/projects/LK";
  const created = await u.tester.post(P + "/releases", { name: "Календарные даты", starts: "2026-12-01", due: "2026-12-18" });
  assert.equal(created.status, 201);
  const route = P + "/releases/" + created.data.num;
  for (const description of ["Версия 1", "Версия 2"]) {
    assert.equal((await u.tester.patch(route, { description })).status, 200);
    const result = await u.tester.get(route);
    assert.equal(result.data.starts, "2026-12-01");
    assert.equal(result.data.due, "2026-12-18");
  }
  const { data } = await u.admin.get(P + "/export");
  assert.equal(data.releases.find((r) => r.num === created.data.num).due, "2026-12-18");
  const imported = await u.admin.post("/api/projects-import", { source: "testball", key: "DATES", data });
  assert.equal(imported.status, 201);
  const copy = await u.admin.get("/api/projects/DATES/releases/" + created.data.num);
  assert.equal(copy.data.starts, "2026-12-01");
  assert.equal(copy.data.due, "2026-12-18");
});
