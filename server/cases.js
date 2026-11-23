const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const folders = require("./folders");
const checklist = require("./checklist");
const events = require("./events");
const casemodel = require("./casemodel");
const trash = require("./trash");
const shared = require("./shared");
const review = require("./review");
const datasets = require("./datasets");
const { wrap, str, tooLong, num } = require("./util");

const router = express.Router({ mergeParams: true });
const STATUSES = ["draft", "review", "ready", "deprecated"];
const PRIORITIES = ["critical", "high", "medium", "low"];

// body — присланное (при правке — поверх текущего кейса, prevSteps — его шаги).
// Шаги принимаются структурой (stepList: [{action, expected, data}]) или текстом по строке на шаг (steps) — так
// работают CSV, старые клиенты API и языковая модель; из текста ожидаемые результаты шагов сохраняются, если действия те же
// Логины участников проекта (и админов) — для полей «пользователь»
async function memberLogins(key) {
  const { rows } = await pool.query(
    "SELECT u.login FROM users u WHERE u.role='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key=$1)", [key]);
  return new Set(rows.map((r) => r.login));
}

function readCase(body, prevSteps = [], stepListSent = body.stepList !== undefined) {
  const c = {
    kind: body.kind === undefined ? "case" : str(body.kind, 20),
    title: str(body.title, 500),
    priority: str(body.priority, 20),
    status: str(body.status, 20),
    pre: str(body.pre),
    steps: str(body.steps),
    expected: str(body.expected),
    stepList: [],
    tags: casemodel.normalizeTags(body.tags) || [],
  };
  if (c.kind === "case") {
    c.stepList = stepListSent ? casemodel.normalizeSteps(body.stepList) : casemodel.stepsFromText(c.steps, prevSteps);
    if (!c.stepList) return { error: "stepList: ожидается список шагов [{action, expected, data}]" };
    c.steps = casemodel.stepsText(c.stepList);
  }
  if (!checklist.KINDS.includes(c.kind)) return { error: "Неизвестный вид: case или checklist" };
  if (!c.title) return { error: c.kind === "checklist" ? "Укажите название чек-листа" : "Укажите название тест-кейса" };
  if (tooLong(body.title, 500)) return { error: tooLong(body.title, 500) };
  if (!PRIORITIES.includes(c.priority)) return { error: "Неизвестный приоритет" };
  if (!STATUSES.includes(c.status)) return { error: "Неизвестный статус" };
  // у чек-листа вместо шагов — пункты, предусловий и ожидаемого результата нет
  if (c.kind === "checklist") {
    const { steps, error } = checklist.check(c.steps);
    if (error) return { error };
    Object.assign(c, { steps, pre: "", expected: "" });
  }
  return { c };
}

router.post("/cases", wrap(async (req, res) => {
  const { c, error } = readCase(req.body);
  if (error) return res.status(400).json({ error });
  const badRef = await shared.checkRefs(req.params.key, c.stepList);
  if (badRef) return res.status(400).json({ error: badRef });
  if (c.status === "review") return res.status(409).json({ error: "На ревью кейс отправляется после создания" });
  const prm = await datasets.readCaseParams(req.params.key, req.body, c.kind);
  if (prm.error) return res.status(400).json({ error: prm.error });
  const cf = await casemodel.readFields(pool, req.params.key, "case", req.body.fields, {}, { members: await memberLogins(req.params.key) });
  if (cf.error) return res.status(400).json({ error: cf.error });
  const folder = await folders.folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  const n = await tx(async (db) => {
    // атомарно берём следующий номер — два одновременных создания не получат один ID
    const r = await db.query("UPDATE projects SET seq=seq+1 WHERE key=$1 RETURNING seq", [req.params.key]);
    if (!r.rows[0]) return null;
    const next = r.rows[0].seq;
    await db.query(
      `INSERT INTO test_cases(project_key, num, kind, folder_id, title, priority, status, preconditions, steps, expected, created_by, updated_by,
         step_list, tags, fields, params, dataset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16)`,
      [req.params.key, next, c.kind, folder, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id,
        JSON.stringify(c.stepList), c.tags, cf.fields, prm.params ? JSON.stringify(prm.params) : null, prm.datasetId ?? null]
    );
    return next;
  });
  if (n === null) return res.status(404).json({ error: "Проект не найден" });
  broadcast("cases", req.params.key, n);
  events.emit(req.params.key, "case.created", { case: await events.snap.testCase(req.params.key, n) }, req.user);
  res.status(201).json({ id: `${req.params.key}-${n}`, num: n });
}));

router.patch("/cases/:num", wrap(async (req, res) => {
  const n = num(req.params.num);
  // частичное обновление: можно прислать только status
  const { rows } = await pool.query(
    `SELECT id, kind, folder_id, title, priority, status, preconditions AS pre, steps, expected, version, edit_revision, step_list, tags, fields
     FROM test_cases WHERE project_key=$1 AND num=$2`, [req.params.key, n]);
  const [current] = rows;
  if (!current) return res.status(404).json({ error: "Тест-кейс не найден" });
  const conflict = ({ version, edit_revision }) => res.status(409).json({
    error: "Кейс уже изменили. Откройте актуальный кейс и перенесите свои правки",
    version, editRevision: edit_revision,
  });
  // шаги: прислали structure — берём её; прислали только текст — разбираем, сохраняя ожидаемые результаты; ничего — как были
  const stepListSent = req.body.stepList !== undefined || req.body.steps === undefined;
  const { c, error } = readCase({ ...current, stepList: current.step_list, ...req.body }, current.step_list, stepListSent);
  if (error) return res.status(400).json({ error });
  const badRef = await shared.checkRefs(req.params.key, c.stepList);
  if (badRef) return res.status(400).json({ error: badRef });
  if (c.status === "review" && current.status !== "review") {
    return res.status(409).json({ error: "На ревью кейс отправляется кнопкой «Отправить на ревью»" });
  }
  // параметры: не прислали — как были; у чек-листа параметров нет
  const prm = await datasets.readCaseParams(req.params.key, req.body, c.kind);
  if (prm.error) return res.status(400).json({ error: prm.error });
  const keepParams = prm.params === undefined && c.kind !== "checklist";
  const cf = await casemodel.readFields(pool, req.params.key, "case", req.body.fields, current.fields, { members: await memberLogins(req.params.key) });
  if (cf.error) return res.status(400).json({ error: cf.error });
  // folder: null — в корень проекта; не прислали — остаётся где был
  const folder = req.body.folder === undefined ? current.folder_id : await folders.folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  if ((req.body.baseVersion !== undefined && Number(req.body.baseVersion) !== current.version)
      || (req.body.baseEditRevision !== undefined && Number(req.body.baseEditRevision) !== current.edit_revision)) {
    return conflict(current);
  }
  // Даже для частичного PATCH проверяем, что строка не изменилась после чтения полей.
  const upd = await pool.query(
    `UPDATE test_cases SET folder_id=$1, title=$2, priority=$3, status=$4, preconditions=$5, steps=$6, expected=$7, updated_by=$8, updated_at=now(), kind=$11,
       step_list=$12, tags=$13, fields=$14,
       params = CASE WHEN $15 THEN params ELSE $16::jsonb END, dataset_id = CASE WHEN $15 THEN dataset_id ELSE $17::int END
     WHERE project_key=$9 AND num=$10 AND id=$18 AND edit_revision=$19 RETURNING version, edit_revision`,
    [folder, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id, req.params.key, n, c.kind,
      JSON.stringify(c.stepList), req.body.tags === undefined ? current.tags : c.tags, cf.fields,
      keepParams, prm.params ? JSON.stringify(prm.params) : null, prm.datasetId ?? null, current.id, current.edit_revision]
  );
  if (!upd.rowCount) {
    const latest = await pool.query("SELECT version, edit_revision FROM test_cases WHERE project_key=$1 AND num=$2", [req.params.key, n]);
    if (!latest.rowCount) return res.status(404).json({ error: "Тест-кейс не найден" });
    return conflict(latest.rows[0]);
  }
  broadcast("cases", req.params.key, n);
  const { version, edit_revision: editRevision } = upd.rows[0];
  if (current.status === "review" && c.status !== "review") await review.cancelPending(pool, [current.id]);
  if (version !== current.version) events.emit(req.params.key, "case.updated", { case: await events.snap.testCase(req.params.key, n), previousVersion: current.version }, req.user);
  res.json({ ok: true, version, editRevision });
}));

// Отметить пункт чек-листа выполненным: {"item": "текст", "done": true | false}, или снять все отметки: {"reset": true}.
// Дата «Обновлён» у чек-листа не меняется — сам чек-лист остался прежним
router.post("/cases/:num/check", wrap(async (req, res) => {
  const where = [req.params.key, num(req.params.num)];
  const { rows } = await pool.query("SELECT kind, steps FROM test_cases WHERE project_key=$1 AND num=$2", where);
  if (!rows[0]) return res.status(404).json({ error: "Чек-лист не найден" });
  if (rows[0].kind !== "checklist") return res.status(400).json({ error: "Отмечать пункты можно только у чек-листа" });
  if (req.body.reset === true) {
    await pool.query("UPDATE test_cases SET checked='{}' WHERE project_key=$1 AND num=$2", where);
  } else {
    const item = str(req.body.item, checklist.MAX_ITEM);
    if (!checklist.items(rows[0].steps).includes(item)) return res.status(404).json({ error: "Такого пункта в чек-листе нет: возможно, его только что изменили" });
    if (typeof req.body.done !== "boolean") return res.status(400).json({ error: "done должно быть true или false" });
    // правка одного ключа прямо в базе: двое, отмечающие разные пункты одновременно, не затрут отметки друг друга
    await pool.query(
      req.body.done
        ? "UPDATE test_cases SET checked = checked || jsonb_build_object($3::text, jsonb_build_object('by', $4::text, 'at', now())) WHERE project_key=$1 AND num=$2"
        : "UPDATE test_cases SET checked = checked - $3::text WHERE project_key=$1 AND num=$2",
      req.body.done ? [...where, item, req.user.login] : [...where, item]
    );
  }
  broadcast("cases", req.params.key, where[1]);
  res.json({ ok: true });
}));

// Массовое изменение выбранных кейсов: статус, приоритет, теги (добавить / убрать), пользовательские поля.
// Каждый изменённый кейс получает новую версию, как при ручной правке. До 1000 кейсов за раз
// «На ревью» массово не ставится — только отправкой на ревью
const CASE_STATUSES = ["draft", "ready", "deprecated"];
const CASE_PRIORITIES = PRIORITIES;
router.post("/cases/bulk", wrap(async (req, res) => {
  const key = req.params.key;
  const nums = [...new Set((Array.isArray(req.body.nums) ? req.body.nums : []).map(num).filter(Boolean))].slice(0, 1000);
  if (!nums.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  const { status, priority } = req.body;
  if (status !== undefined && !CASE_STATUSES.includes(status)) return res.status(400).json({ error: `Статус: ${CASE_STATUSES.join(", ")}` });
  if (priority !== undefined && !CASE_PRIORITIES.includes(priority)) return res.status(400).json({ error: `Приоритет: ${CASE_PRIORITIES.join(", ")}` });
  const add = casemodel.normalizeTags(req.body.addTags || []) || [];
  const removeTags = new Set(casemodel.normalizeTags(req.body.removeTags || []) || []);
  const patch = req.body.fields;
  if (status === undefined && priority === undefined && !add.length && !removeTags.size && !patch) return res.status(400).json({ error: "Укажите, что изменить" });
  const members = patch ? await memberLogins(key) : null;
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, num, status, priority, tags, fields FROM test_cases WHERE project_key=$1 AND num = ANY($2::int[]) FOR UPDATE", [key, nums]);
    let changed = 0;
    for (const c of rows) {
      const tags = [...new Set([...c.tags, ...add])].filter((t) => !removeTags.has(t));
      let fields = c.fields;
      if (patch) {
        const cf = await casemodel.readFields(db, key, "case", patch, c.fields, { members });
        if (cf.error) return { status: 400, error: `${key}-${c.num}: ${cf.error}` };
        fields = cf.fields;
      }
      const same = (status ?? c.status) === c.status && (priority ?? c.priority) === c.priority
        && JSON.stringify(tags) === JSON.stringify(c.tags) && JSON.stringify(fields) === JSON.stringify(c.fields);
      if (same) continue;
      await db.query("UPDATE test_cases SET status=$2, priority=$3, tags=$4, fields=$5, updated_by=$6, updated_at=now() WHERE id=$1",
        [c.id, status ?? c.status, priority ?? c.priority, tags, fields, req.user.id]);
      if (c.status === "review" && status !== undefined && status !== "review") await review.cancelPending(db, [c.id]);
      changed++;
    }
    return { changed, found: rows.length };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  if (out.changed) broadcast("cases");
  res.json({ changed: out.changed, skipped: nums.length - out.changed });
}));

// Массовое удаление в корзину. Кейсы из заблокированных планов пропускаются
router.post("/cases/bulk-delete", wrap(async (req, res) => {
  const key = req.params.key;
  const nums = [...new Set((Array.isArray(req.body.nums) ? req.body.nums : []).map(num).filter(Boolean))].slice(0, 1000);
  if (!nums.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  const locked = new Set((await pool.query(
    `SELECT DISTINCT c.num FROM plan_cases pc JOIN test_plans p ON p.id=pc.plan_id JOIN test_cases c ON c.id=pc.case_id
     WHERE c.project_key=$1 AND c.num = ANY($2::int[]) AND p.locked`, [key, nums]
  )).rows.map((r) => r.num));
  let deleted = 0;
  for (const n of nums) {
    if (locked.has(n)) continue;
    const r = await trash.remove(req, "case", n);
    if (!r) continue;
    deleted++;
    events.emit(key, "case.deleted", { case: { id: `${key}-${n}`, num: n, title: r.title } }, req.user);
  }
  if (deleted) broadcast("cases");
  res.json({ deleted, locked: [...locked] });
}));

router.delete("/cases/:num", wrap(async (req, res) => {
  const locked = await pool.query(
    `SELECT p.num FROM plan_cases pc JOIN test_plans p ON p.id=pc.plan_id JOIN test_cases c ON c.id=pc.case_id
     WHERE c.project_key=$1 AND c.num=$2 AND p.locked LIMIT 1`,
    [req.params.key, num(req.params.num)]
  );
  if (locked.rows[0]) return res.status(409).json({ error: `Кейс входит в заблокированный тест-план ${req.params.key}-P${locked.rows[0].num}. Пометьте его устаревшим вместо удаления` });
  // в корзину: кейс с версиями, результатами и комментариями можно восстановить (server/trash.js)
  const r = await trash.remove(req, "case", num(req.params.num));
  if (!r) return res.status(404).json({ error: "Тест-кейс не найден" });
  broadcast("cases");
  events.emit(req.params.key, "case.deleted", { case: { id: `${req.params.key}-${req.params.num}`, num: num(req.params.num), title: r.title } }, req.user);
  res.json({ ok: true, trashId: r.trashId });
}));

// ---------- версии тест-кейса ----------
const versionOut = (v) => ({
  version: v.version, kind: v.kind, title: v.title, priority: v.priority, status: v.status, pre: v.preconditions, steps: v.steps,
  expected: v.expected, stepList: v.step_list_expanded || v.step_list, tags: v.tags, fields: v.fields, changedBy: v.changed_by_login, changed: v.changed_at.getTime(),
});
const versionSql = `SELECT v.*, expand_steps(v.step_list) AS step_list_expanded, u.login AS changed_by_login FROM test_case_versions v JOIN test_cases c ON c.id=v.case_id
  LEFT JOIN users u ON u.id=v.changed_by WHERE c.project_key=$1 AND c.num=$2`;

router.get("/cases/:num/versions", wrap(async (req, res) => {
  const { rows } = await pool.query(`${versionSql} ORDER BY v.version DESC`, [req.params.key, num(req.params.num)]);
  if (!rows.length) return res.status(404).json({ error: "Тест-кейс не найден" });
  res.json({ versions: rows.map(versionOut) });
}));

router.get("/cases/:num/versions/:v", wrap(async (req, res) => {
  const { rows } = await pool.query(`${versionSql} AND v.version=$3`, [req.params.key, num(req.params.num), num(req.params.v)]);
  if (!rows[0]) return res.status(404).json({ error: "Версия не найдена" });
  res.json(versionOut(rows[0]));
}));

// Вернуть кейс к прежней версии: создаётся новая версия с тем же содержимым (история не переписывается)
router.post("/cases/:num/versions/:v/restore", wrap(async (req, res) => {
  const { rows } = await pool.query(`${versionSql} AND v.version=$3`, [req.params.key, num(req.params.num), num(req.params.v)]);
  if (!rows[0]) return res.status(404).json({ error: "Версия не найдена" });
  const v = rows[0];
  const upd = await pool.query(
    `UPDATE test_cases SET kind=$1, title=$2, priority=$3, status=$4, preconditions=$5, steps=$6, expected=$7, updated_by=$8, updated_at=now(),
       step_list=$11, tags=$12, fields=$13
     WHERE project_key=$9 AND num=$10 RETURNING version`,
    [v.kind, v.title, v.priority, v.status, v.preconditions, v.steps, v.expected, req.user.id, req.params.key, num(req.params.num),
      JSON.stringify(v.step_list), v.tags, v.fields]
  );
  broadcast("cases", req.params.key, num(req.params.num));
  events.emit(req.params.key, "case.updated", { case: await events.snap.testCase(req.params.key, num(req.params.num)), restoredFrom: v.version }, req.user);
  res.json({ ok: true, version: upd.rows[0].version });
}));

module.exports = router;
