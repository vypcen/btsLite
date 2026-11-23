// Клиентская сборка: лицензионное соглашение при первом запуске (EULA_REQUIRED=true) и полоса «Пробная версия»
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
const early = {};
test.before(async () => {
  srv = await startServer({ EULA_REQUIRED: "true" });
  // проверки до принятия соглашения — сразу после регистрации первого администратора
  u = await seed(srv, {
    onAdmin: async (admin) => {
      early.me = (await admin.get("/api/auth/me")).data.user;
      early.users = await admin.post("/api/admin/users", { login: "x1", name: "X", password: "Tb-pass-2026", role: "tester" });
      early.help = await admin.get("/api/help");
      early.text = (await admin.get("/api/eula")).data;
      early.accept = await admin.post("/api/eula/accept", {});
      early.after = (await admin.get("/api/auth/me")).data.user;
    },
  });
});
test.after(async () => srv && (await srv.stop()));

test("соглашение: до принятия администратором работа закрыта, после — открыта; принятие в журнале", async () => {
  assert.equal(early.me.eula, "accept");
  assert.equal(early.users.status, 403, "до принятия даже администратор не управляет системой");
  assert.equal(early.users.data.code, "eula_required");
  assert.equal(early.help.status, 200, "справка доступна");
  assert.equal(early.text.required, true);
  assert.equal(early.text.accepted, false);
  assert.match(early.text.html, /Лицензионное соглашение TestBall QA/);
  assert.doesNotMatch(early.text.html, /ЧЕРНОВИК/, "служебный комментарий не показывается");
  assert.equal(early.accept.status, 200);
  assert.equal(early.after.eula, null);

  // после принятия — работа для всех; повторно принимать нельзя не-администратору
  assert.equal((await u.tester.get("/api/auth/me")).data.user.eula, null);
  assert.equal((await u.tester.get("/api/projects/LK/state")).status, 200);
  assert.equal((await u.tester.post("/api/eula/accept", {})).status, 403);
  const s = (await u.tester.get("/api/eula")).data;
  assert.equal(s.accepted, true);
  assert.equal(s.acceptedBy, "admin");
  const audit = await u.admin.get("/api/admin/audit?action=eula.accept");
  assert.equal(audit.data.items.length, 1);
});
