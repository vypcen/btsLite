const { Client, Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 10),
});

pool.on("error", (err) => {
  console.error("[db] Ошибка соединения с PostgreSQL:", err.message);
});

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Отдельное подключение удерживает блокировку до остановки экземпляра Community.
async function lockInstance() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(7204313) AS acquired");
    if (!rows[0].acquired) throw new Error("К этой базе уже подключён экземпляр BlackCat Testing Community");
    client.on("error", (error) => {
      console.error("[db] Потеряна блокировка экземпляра Community:", error.message);
      process.exit(1);
    });
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

module.exports = { pool, tx, lockInstance };
