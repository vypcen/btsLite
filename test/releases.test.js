const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

test("релиз Lite: простая карточка и связь с прогоном, без спринтов и готовности", async (t) => {
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
