const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer, seed } = require("./helpers");

test("Community: до двух активных проектов при создании, импорте и восстановлении", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { admin } = await seed(srv);
  const create = (key) => admin.post("/api/projects", { key, name: key });
  const trash = (key) => admin.del("/api/projects/" + key, { confirm: key });
  const restore = (key) => admin.post("/api/admin/projects/" + key + "/restore");
  const data = (await admin.get("/api/projects/LK/export")).data;
  const importAs = (key) => admin.post("/api/projects-import", { key, source: "testball", data });
  const competing = await Promise.all([create("NEW"), importAs("COPY")]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.match(competing.find((r) => r.status === 409).data.error, /2 активных проектов/);
  const chosen = competing[0].status === 201 ? "NEW" : "COPY";
  assert.equal((await create("THIRD")).status, 409);
  assert.equal((await importAs("OTHER")).status, 409);
  assert.equal((await trash(chosen)).status, 200);
  assert.equal((await importAs("OTHER")).status, 201);
  assert.equal((await restore(chosen)).status, 409);
  assert.equal((await trash("OTHER")).status, 200);
  assert.equal((await restore(chosen)).status, 200);
  assert.deepEqual((await admin.get("/api/state")).data.projects.map((p) => p.id).sort(), ["LK", chosen].sort());
});
