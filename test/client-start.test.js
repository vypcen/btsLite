const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u, firstState;
test.before(async () => {
  // У существующих установок этот флаг мог остаться в конфигурации.
  srv = await startServer({ EULA_REQUIRED: "true" });
  u = await seed(srv, {
    onAdmin: async (admin) => { firstState = await admin.get("/api/state"); },
  });
});
test.after(async () => srv && (await srv.stop()));

test("первая регистрация открывает работу и при старой конфигурации установки", async () => {
  assert.equal(firstState.status, 200);
  assert.deepEqual(firstState.data.projects, []);
  assert.equal((await u.tester.get("/api/projects/LK/state")).status, 200);
  assert.equal((await u.admin.get("/api/auth/me")).data.user.eula, undefined);
  assert.equal((await u.admin.get("/api/eula")).status, 404);
});
