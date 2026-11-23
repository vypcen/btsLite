// Лицензии (места). Полное место — роли, которые меняют данные: tester и admin.
// Просмотровое место — developer (просмотр и комментарии) и viewer (только просмотр).
// Community: пять полных мест, просмотровые без ограничений.
// Заблокированные пользователи места не занимают.
const roles = require("./roles");
// встроенные роли; пользовательская роль занимает полное место, если в ней есть разрешения сверх просмотровых (roles.seatOf)
const FULL_LIMIT = 5;
const FULL_ERROR = "Все полные места Community заняты (5). Освободите место или выдайте просмотровую роль.";
const kindOf = (role) => roles.seatOf(role);

// Пользователь занимает полное место, если полная у него глобальная роль или роль хотя бы в одном проекте
const IS_FULL = `(u.role = ANY($1::text[]) OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.role = ANY($1::text[])))`;

async function usage(db) {
  await roles.load();
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE ${IS_FULL})::int AS full, count(*) FILTER (WHERE NOT ${IS_FULL})::int AS view
     FROM users u WHERE NOT blocked`,
    [roles.fullRoles()]
  );
  return { full: { used: rows[0].full, limit: FULL_LIMIT }, view: { used: rows[0].view, limit: null } };
}

// Можно ли пользователю (новому — userId null) получить роль role. Возвращает текст ошибки или null
async function check(db, role, userId = null) {
  await roles.load();
  const kind = kindOf(role);
  if (kind === "view") return null;
  // пользователь уже занимает полное место (например, полной ролью в проекте) — новое не нужно
  if (kind === "full" && userId) {
    const { rows } = await db.query(`SELECT ${IS_FULL} AS full FROM users u WHERE u.id=$2 AND NOT u.blocked`, [roles.fullRoles(), userId]);
    if (rows[0]?.full) return null;
  }
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users u WHERE NOT blocked AND u.id IS DISTINCT FROM $2 AND ${kind === "full" ? IS_FULL : `NOT ${IS_FULL}`}`,
    [roles.fullRoles(), userId]
  );
  return rows[0].n < FULL_LIMIT ? null : FULL_ERROR;
}

module.exports = { usage, check, FULL_LIMIT, FULL_ERROR };
