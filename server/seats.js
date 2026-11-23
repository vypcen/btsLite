const LIMIT = 5;
const LIMIT_ERROR = "Все 5 мест Community заняты. Заблокируйте или удалите пользователя, чтобы освободить место.";

async function usage(db) {
  const { rows: [{ used }] } = await db.query("SELECT count(*)::int AS used FROM users WHERE NOT blocked");
  return { used, limit: LIMIT };
}

module.exports = { LIMIT, LIMIT_ERROR, usage };
