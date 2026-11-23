// Ход выполнения тест-плана: последний отмеченный результат кейса по прогонам плана, исполнитель, сводка в списке планов
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && (await srv.stop()));
const P = "/api/projects/LK";

test("план показывает последний результат по своим прогонам, а не по чужим", async () => {
  const f = (await u.tester.post(`${P}/folders`, { name: "Оплата" })).data.id;
  const nums = [];
  for (const t of ["Карта", "СБП", "Возврат", "Чек"]) nums.push((await u.tester.post(`${P}/cases`, { title: t, priority: "high", status: "ready", folder: t === "Чек" ? null : f })).data.num);
  const plan = (await u.tester.post(`${P}/plans`, { title: "Регресс", mode: "static", caseNums: nums })).data;

  let r = await u.tester.get(`${P}/plans/${plan.num}/cases`);
  assert.equal(r.data.progress.untested, 4);
  assert.equal(r.data.cases[0].runs, 0);

  const r1 = (await u.tester.post(`${P}/plans/${plan.num}/runs`, { title: "Chrome" })).data.runs[0];
  await u.tester.patch(`${P}/runs/${r1}/results/${nums[0]}`, { result: "failed" });
  await u.tester.patch(`${P}/runs/${r1}/results/${nums[1]}`, { result: "passed", assignee: "tester" });
  // второй прогон плана: первый кейс исправили, второй ещё не проверен — результат «пройден» из первого остаётся
  const r2 = (await u.tester.post(`${P}/plans/${plan.num}/runs`, { title: "Повтор" })).data.runs[0];
  await u.tester.patch(`${P}/runs/${r2}/results/${nums[0]}`, { result: "passed" });
  // прогон не по плану на тот же кейс не влияет
  const other = (await u.tester.post(`${P}/runs`, { title: "Вне плана", caseNums: [nums[2]] })).data;
  await u.tester.patch(`${P}/runs/${other.num}/results/${nums[2]}`, { result: "failed" });

  r = await u.tester.get(`${P}/plans/${plan.num}/cases`);
  const by = Object.fromEntries(r.data.cases.map((c) => [c.num, c]));
  assert.equal(by[nums[0]].result, "passed");
  assert.equal(by[nums[0]].runNum, r2);
  assert.equal(by[nums[0]].runs, 2);
  assert.equal(by[nums[1]].result, "passed");
  assert.equal(by[nums[1]].runNum, r1);
  assert.equal(by[nums[1]].assignee, "tester");
  assert.equal(by[nums[1]].executedBy, "tester");
  assert.equal(by[nums[2]].result, "untested");
  assert.equal(by[nums[0]].folder, f);
  assert.equal(by[nums[3]].folder, null);
  assert.deepEqual(r.data.progress, { passed: 2, failed: 0, blocked: 0, skipped: 0, untested: 2 });

  const list = (await u.tester.get(`${P}/plans`)).data.plans.find((x) => x.num === plan.num);
  assert.deepEqual(list.progress, { passed: 2, failed: 0, blocked: 0, skipped: 0, untested: 2 });
});
