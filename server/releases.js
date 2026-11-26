// Релизы и майлстоуны (E-01). Релиз (или спринт внутри него) собирает планы, прогоны и баги; страница релиза
// показывает готовность: сколько кейсов проверено и пройдено по последним результатам в прогонах релиза, открытые баги,
// сроки. Прогон по плану и перезапуск наследуют релиз, баг из прогона — релиз прогона (триггеры в миграции 031).
// Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { wrap, str, num, tooLong } = require("./util");

const router = express.Router({ mergeParams: true });
const STATUSES = ["planned", "active", "released", "cancelled"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const calendarDates = "to_char(r.starts_on, 'YYYY-MM-DD') AS starts, to_char(r.due_on, 'YYYY-MM-DD') AS due";
const toRelease = (r) => ({
  id: r.id, num: r.num, ref: `${r.project_key}-V${r.num}`, name: r.name, description: r.description, status: r.status, parent: r.parent_num ?? null,
  starts: r.starts, due: r.due, released: r.released_at ? r.released_at.getTime() : null,
  createdBy: r.created_login || null, created: r.created_at.getTime(),
});
const baseSql = `SELECT r.*, p.num AS parent_num, u.login AS created_login, ${calendarDates} FROM releases r
  LEFT JOIN releases p ON p.id=r.parent_id LEFT JOIN users u ON u.id=r.created_by`;

router.get("/releases", wrap(async (req, res) => {
  const { rows } = await pool.query(`${baseSql} WHERE r.project_key=$1 ORDER BY COALESCE(r.due_on, '9999-12-31'), r.num`, [req.params.key]);
  res.json({ items: rows.map(toRelease) });
}));

router.get("/releases/:num(\\d+)", wrap(async (req, res) => {
  const { rows } = await pool.query(`${baseSql} WHERE r.project_key=$1 AND r.num=$2`, [req.params.key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Релиз не найден" });
  res.json(toRelease(rows[0]));
}));

async function readRelease(body, prev = {}) {
  const r = {
    name: body.name === undefined ? prev.name : str(body.name, 200),
    description: body.description === undefined ? prev.description ?? "" : str(body.description, 5000),
    status: body.status === undefined ? prev.status ?? "planned" : str(body.status, 20),
    starts: body.starts === undefined ? prev.starts ?? null : body.starts || null,
    due: body.due === undefined ? prev.due ?? null : body.due || null,
    parentId: prev.parent_id ?? null,
  };
  if (!r.name) return { error: "Укажите название релиза" };
  const long = tooLong(body.name, 200);
  if (long) return { error: long };
  if (!STATUSES.includes(r.status)) return { error: `Статус: ${STATUSES.join(", ")}` };
  for (const d of [r.starts, r.due]) {
    if (d !== null && (typeof d !== "string" || !DATE.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) {
      return { error: "Даты — в формате ГГГГ-ММ-ДД" };
    }
  }
  if (r.starts && r.due && r.starts > r.due) return { error: "Начало позже срока" };
  if (body.parent != null && num(body.parent) !== (await pool.query("SELECT num FROM releases WHERE id=$1", [prev.parent_id ?? null])).rows[0]?.num) {
    return { error: "Создание и перенос спринтов доступны в Enterprise" };
  }
  return { r };
}

const dup = (e) => e.code === "23505" && /releases_name/.test(e.constraint || "");

router.post("/releases", wrap(async (req, res) => {
  const { r, error } = await readRelease(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const out = await tx(async (db) => {
      const seq = await db.query("UPDATE projects SET release_seq=release_seq+1 WHERE key=$1 RETURNING release_seq", [req.params.key]);
      if (!seq.rows[0]) return null;
      const n = seq.rows[0].release_seq;
      await db.query(
        `INSERT INTO releases(project_key, num, parent_id, name, description, status, starts_on, due_on, created_by, released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6='released' THEN now() END)`,
        [req.params.key, n, r.parentId, r.name, r.description, r.status, r.starts, r.due, req.user.id]);
      return { num: n, ref: `${req.params.key}-V${n}` };
    });
    if (!out) return res.status(404).json({ error: "Проект не найден" });
    broadcast("runs");
    res.status(201).json(out);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Релиз с таким названием уже есть" });
    throw e;
  }
}));

router.patch("/releases/:num(\\d+)", wrap(async (req, res) => {
  const prev = (await pool.query(`SELECT r.*, ${calendarDates} FROM releases r WHERE project_key=$1 AND num=$2`, [req.params.key, num(req.params.num)])).rows[0];
  if (!prev) return res.status(404).json({ error: "Релиз не найден" });
  const { r, error } = await readRelease(req.body, prev);
  if (error) return res.status(400).json({ error });
  if (r.parentId && (await pool.query("SELECT 1 FROM releases WHERE parent_id=$1 LIMIT 1", [prev.id])).rows[0]) {
    return res.status(400).json({ error: "У релиза есть спринты — сделать его спринтом нельзя" });
  }
  try {
    await pool.query(
      `UPDATE releases SET name=$2, description=$3, status=$4, starts_on=$5, due_on=$6, parent_id=$7,
         released_at = CASE WHEN $4='released' THEN COALESCE(released_at, now()) ELSE NULL END WHERE id=$1`,
      [prev.id, r.name, r.description, r.status, r.starts, r.due, r.parentId]);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Релиз с таким названием уже есть" });
    throw e;
  }
  broadcast("runs");
  res.json({ ok: true });
}));

// Удалить релиз (и его спринты): планы, прогоны и баги остаются, только отвязываются
router.delete("/releases/:num(\\d+)", wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM releases WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!rowCount) return res.status(404).json({ error: "Релиз не найден" });
  broadcast("runs");
  broadcast("plans");
  res.json({ ok: true });
}));

// Релиз при создании прогона, плана или бага: {"release": номер} → id или {error}
async function releaseId(db, key, ref) {
  if (ref === undefined || ref === null || ref === "") return { id: null };
  const r = (await db.query("SELECT id FROM releases WHERE project_key=$1 AND num=$2", [key, num(ref)])).rows[0];
  return r ? { id: r.id } : { error: "Релиз не найден" };
}

module.exports = { router, releaseId, STATUSES };
