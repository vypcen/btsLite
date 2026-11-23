// Роли и разрешения: встроенные наборы, лицензионные места
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
});
test.after(async () => srv && srv.stop());

test("разработчик меняет статус бага, но не правит и не заводит баги", async () => {
  const bug = (await u.tester.post("/api/projects/LK/bugs", { title: "Кнопка не жмётся", severity: "major" })).data.num;
  assert.equal((await u.dev.patch(`/api/projects/LK/bugs/${bug}`, { status: "in_progress" })).status, 200);
  const r = await u.dev.patch(`/api/projects/LK/bugs/${bug}`, { title: "Переименовал" });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /изменять баги/);
  assert.equal((await u.dev.post("/api/projects/LK/bugs", { title: "Новый", severity: "minor" })).status, 403);
  assert.equal((await u.viewer.patch(`/api/projects/LK/bugs/${bug}`, { status: "fixed" })).status, 403);
  const meta = (await u.dev.get("/api/state")).data;
  assert.deepEqual(meta.projects.find((p) => p.id === "LK").myPermissions.sort(), ["bugs.status", "comments"]);
});
