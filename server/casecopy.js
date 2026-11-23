// Копирование тест-кейсов и чек-листов: в ту же папку («Создать копию» в карточке), в другую папку или в другой проект.
// Копия — новый кейс со своим номером и первой версией; вложения кейса копируются (отдельными файлами — удаление
// у одного не задевает другой); история прогонов, комментарии, ревью и связи с требованиями и автотестами остаются у оригинала. Монтируется на /api/projects/:key
//
// POST /cases/copy {nums: [1,2], folder?: id|null, project?: "KEY"}
//   folder не передан — копия в ту же папку (в том же проекте) или в корень (в другом проекте);
//   в том же проекте к названию добавляется «(копия)», в другой проект кейс уходит с прежним названием.
// В другом проекте свои общие шаги, наборы данных и пользовательские поля, поэтому:
//   ссылки на общие шаги раскрываются в обычные шаги; набор данных проекта переносится таблицей в сам кейс;
//   значения полей переносятся в поля с тем же названием и типом, остальные отбрасываются (об этом — в ответе).
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const access = require("./access");
const roles = require("./roles");
const folders = require("./folders");
const events = require("./events");
const attachments = require("./attachments");
const storage = require("./storage");
const { wrap, str, num } = require("./util");

const router = express.Router({ mergeParams: true });
const MAX = 500;
const SUFFIX = " (копия)";

// шаги без ссылок: блок общих шагов → его шаги (для переноса в другой проект)
async function expandShared(db, key, list) {
  const ids = list.filter((s) => s.shared).map((s) => s.shared);
  if (!ids.length) return list;
  const { rows } = await db.query("SELECT id, step_list FROM shared_steps WHERE project_key=$1 AND id = ANY($2::int[])", [key, ids]);
  const byId = new Map(rows.map((r) => [r.id, r.step_list]));
  return list.flatMap((s) => (s.shared ? (byId.get(s.shared) || []) : [s]));
}

// значения полей по названию и типу: id полей в разных проектах разные
async function fieldMapper(db, from, to) {
  const q = (k) => db.query("SELECT id, name, type, options FROM custom_fields WHERE project_key=$1 AND entity='case'", [k]).then((r) => r.rows);
  const [src, dst] = await Promise.all([q(from), q(to)]);
  const target = new Map(dst.map((f) => [`${f.name.toLowerCase()}|${f.type}`, f]));
  const map = new Map();
  for (const f of src) {
    const t = target.get(`${f.name.toLowerCase()}|${f.type}`);
    if (t) map.set(String(f.id), t);
  }
  const dropped = new Set();
  const convert = (fields) => {
    const out = {};
    for (const [id, v] of Object.entries(fields || {})) {
      const t = map.get(String(id));
      if (!t) { const f = src.find((x) => String(x.id) === String(id)); if (f && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) dropped.add(f.name); continue; }
      // у списков значение должно быть среди вариантов целевого поля
      if (t.type === "select" && !(t.options || []).includes(v)) { dropped.add(t.name); continue; }
      if (t.type === "multiselect") { const ok = (Array.isArray(v) ? v : []).filter((x) => (t.options || []).includes(x)); if (ok.length !== (v || []).length) dropped.add(t.name); out[t.id] = ok; continue; }
      out[t.id] = v;
    }
    return out;
  };
  return { convert, dropped };
}

router.post("/cases/copy", wrap(async (req, res) => {
  const from = req.params.key;
  const nums = [...new Set((Array.isArray(req.body.nums) ? req.body.nums : []).map(num).filter(Boolean))];
  if (!nums.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  if (nums.length > MAX) return res.status(400).json({ error: `За один раз — не больше ${MAX} кейсов` });
  const to = str(req.body.project, 10).toUpperCase() || from;
  const other = to !== from;

  let targetRole = req.projectRole;
  if (other) {
    // права в проекте-получателе проверяем сами: access.project проверил только исходный
    targetRole = await access.projectRole(req.user, to);
    if (!targetRole) return res.status(404).json({ error: "Проект для копии не найден" });
    await roles.load();
    if (!roles.allowed(targetRole, "cases.edit")) return res.status(403).json({ error: `В проекте ${to}: ${roles.deniedText("cases.edit").replace(/^Ваша роль в этом проекте не позволяет/, "ваша роль не позволяет")}` });
  }
  const keepFolder = req.body.folder === undefined;
  const folder = keepFolder ? null : await folders.folderId(pool, to, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });

  const { rows: src } = await pool.query(
    `SELECT id, num, kind, folder_id, title, priority, status, preconditions, steps, expected, step_list, tags, fields, params, dataset_id
     FROM test_cases WHERE project_key=$1 AND num = ANY($2::int[]) ORDER BY array_position($2::int[], num)`,
    [from, nums]
  );
  if (!src.length) return res.status(404).json({ error: "Тест-кейсы не найдены" });

  const written = []; // скопированные файлы: если транзакция откатится, их надо убрать
  const result = await tx(async (db) => {
    const fm = other ? await fieldMapper(db, from, to) : null;
    let expanded = 0;
    const created = [];
    for (const c of src) {
      let stepList = c.step_list || [];
      let params = c.params;
      let datasetId = c.dataset_id;
      if (other) {
        if (stepList.some((s) => s.shared)) { stepList = await expandShared(db, from, stepList); expanded++; }
        if (datasetId) {
          const { rows } = await db.query("SELECT columns, rows FROM datasets WHERE id=$1", [datasetId]);
          params = rows[0] ? { columns: rows[0].columns, rows: rows[0].rows } : null;
          datasetId = null;
        }
      }
      const status = c.status === "review" ? "draft" : c.status;
      const title = other ? c.title : (c.title + SUFFIX).slice(0, 500);
      const n = (await db.query("UPDATE projects SET seq=seq+1 WHERE key=$1 RETURNING seq", [to])).rows[0].seq;
      const ins = await db.query(
        `INSERT INTO test_cases(project_key, num, kind, folder_id, title, priority, status, preconditions, steps, expected, created_by, updated_by,
           step_list, tags, fields, params, dataset_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [to, n, c.kind, keepFolder ? (other ? null : c.folder_id) : folder, title, c.priority, status, c.preconditions, c.steps, c.expected, req.user.id,
          JSON.stringify(stepList), c.tags, other ? fm.convert(c.fields) : c.fields, params ? JSON.stringify(params) : null, datasetId]
      );
      const { rows: files } = await db.query("SELECT id, filename, mime, size, step_index FROM attachments WHERE case_id=$1 ORDER BY created_at", [c.id]);
      for (const f of files) {
        const id = await attachments.writeFile(await attachments.readFile(f.id));
        written.push(id);
        await db.query("INSERT INTO attachments(id, case_id, filename, mime, size, uploaded_by, step_index) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [id, ins.rows[0].id, f.filename, f.mime, f.size, req.user.id, f.step_index]);
      }
      created.push({ from: c.num, num: n, id: `${to}-${n}` });
    }
    return { created, expanded, droppedFields: fm ? [...fm.dropped] : [] };
  }).catch(async (e) => {
    for (const id of written) await storage.remove(id).catch(() => {});
    throw e;
  });
  broadcast("cases", to);
  for (const c of result.created) events.emit(to, "case.created", { case: await events.snap.testCase(to, c.num) }, req.user);
  res.status(201).json({ project: to, ...result });
}));

module.exports = { router };
