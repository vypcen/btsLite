#!/usr/bin/env node
// Резервные копии из командной строки — те же, что «Пользователи → Резервные копии».
//   node scripts/backup.js create            — сделать копию (CronJob в Kubernetes, cron на сервере)
//   node scripts/backup.js verify <файл.tar>  — проверить копию: контрольные суммы, дамп, архив вложений
//   node scripts/backup.js restore <файл.tar> --yes — восстановить базу (и вложения при STORAGE=local)
//                                              в DATABASE_URL. Приложение на время восстановления остановите.
// Нужны DATABASE_URL и те же переменные хранилища (STORAGE, S3_*, UPLOAD_DIR), что у приложения.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HELP = `Использование:
  node scripts/backup.js create
  node scripts/backup.js verify <файл.tar>
  node scripts/backup.js restore <файл.tar> --yes`;

function syncPath(file) {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function installUploads(archive, target, sha256) {
  const staging = fs.mkdtempSync(path.join(target, ".restore-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
      if (!UUID_RE.test(entry.name)) continue; // .part и другие служебные файлы приложению не нужны
      if (!entry.isFile()) throw new Error(`В архиве вложение ${entry.name} должно быть обычным файлом`);
      const source = path.join(staging, entry.name);
      const dest = path.join(target, entry.name);
      syncPath(source);
      try {
        // Один том, в том числе в Docker. Существующий файл не перезаписываем даже при прерванном восстановлении.
        fs.linkSync(source, dest);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (!fs.lstatSync(dest).isFile() || await sha256(source) !== await sha256(dest)) {
          throw new Error(`Вложение ${entry.name} уже существует с другим содержимым; восстановите в отдельное хранилище`);
        }
      }
    }
    syncPath(target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function pg(cmd, args) {
  const bin = process.env.BACKUP_PG_BIN ? path.join(process.env.BACKUP_PG_BIN, cmd) : cmd;
  try {
    execFileSync(bin, args, { stdio: ["ignore", "ignore", "inherit"] });
  } catch (e) {
    // Не печатаем строку команды: в аргументах psql есть DATABASE_URL.
    throw new Error(`${cmd} завершился с ошибкой (${e.code || e.signal || e.status})`);
  }
}

async function restore(work, dir, manifest) {
  const { verifyDir, sha256 } = require("../server/backup");
  const verified = await verifyDir(dir, manifest, { probeDatabase: false });
  if (!verified.ok) {
    const details = verified.checks.filter((c) => c.ok === false).map((c) => `${c.what}: ${c.note}`).join("; ");
    throw new Error(`Копия не прошла проверку. ${details}`);
  }

  // Сначала полностью читаем дамп. psql получит готовый SQL и выполнит проверку вложений до COMMIT.
  const dumpSql = path.join(work, "restore.sql");
  pg("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error", "--file", dumpSql, path.join(dir, "db.dump")]);
  const storage = require("../server/storage");
  const uploads = path.join(dir, "uploads.tar.gz");
  if (storage.kind === "local" && fs.existsSync(uploads)) await installUploads(uploads, storage.DIR, sha256);
  const filenames = storage.kind === "s3"
    ? (await storage.list()).map((f) => f.name)
    : fs.readdirSync(storage.DIR, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name);
  const ids = [...new Set(filenames.filter((name) => UUID_RE.test(name)))];

  const checkSql = path.join(work, "check-uploads.sql");
  fs.writeFileSync(checkSql, `CREATE TEMP TABLE restore_uploads (id uuid PRIMARY KEY) ON COMMIT DROP;
COPY pg_temp.restore_uploads (id) FROM STDIN;
${ids.map((id) => `${id}\n`).join("")}\\.
DO $check$
DECLARE missing uuid;
BEGIN
  SELECT required.id INTO missing FROM (
    SELECT id FROM public.attachments
    UNION ALL SELECT f.id FROM public.trash CROSS JOIN LATERAL unnest(files) AS f(id)
  ) required
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.restore_uploads u WHERE u.id=required.id) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'В целевом хранилище нет файла вложения %', missing;
  END IF;
END
$check$;
`, { mode: 0o600 });

  console.log(`Восстанавливаю базу из копии ${manifest.createdAt} (версия ${manifest.version})…`);
  pg("psql", ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--single-transaction", "--dbname", process.env.DATABASE_URL, "--file", dumpSql, "--file", checkSql]);
  console.log("Готово. Запустите приложение: недостающие миграции оно применит само.");
}

async function main(argv) {
  const [cmd, file] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return console.log(HELP);
  if (!process.env.DATABASE_URL) throw new Error("Задайте DATABASE_URL");
  if (cmd === "create") {
    const backup = require("../server/backup");
    const r = await backup.create({ trigger: process.env.BACKUP_TRIGGER === "manual" ? "manual" : "cron" });
    console.log(`Готово: ${r.name}, ${(r.size / 1024 / 1024).toFixed(1)} МБ, проверка: ${r.verify.ok ? "пройдена" : "есть замечания"}`);
    for (const c of r.verify.checks) console.log(`  ${c.ok === false ? "✗" : c.ok ? "✓" : "–"} ${c.what}: ${c.note || ""}`);
    if (!r.verify.ok) process.exitCode = 2;
    return;
  }
  if (!["verify", "restore"].includes(cmd) || !file) throw new Error(HELP);
  if (cmd === "restore" && !argv.includes("--yes")) {
    throw new Error("Восстановление перезапишет данные в DATABASE_URL. Остановите приложение и повторите с --yes");
  }
  if (!fs.existsSync(file)) throw new Error(`Файл не найден: ${file}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tb-restore-"));
  try {
    const dir = path.join(work, "parts");
    fs.mkdirSync(dir);
    execFileSync("tar", ["-xf", file, "-C", dir]);
    const manifestFile = path.join(dir, "manifest.json");
    if (!fs.lstatSync(manifestFile).isFile()) throw new Error("manifest.json должен быть обычным файлом");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (cmd === "verify") {
      const { verifyDir } = require("../server/backup");
      const v = await verifyDir(dir, manifest);
      console.log(`Копия ${path.basename(file)}: версия ${manifest.version}, миграция ${manifest.migration}, создана ${manifest.createdAt}`);
      for (const c of v.checks) console.log(`  ${c.ok === false ? "✗" : c.ok ? "✓" : "–"} ${c.what}: ${c.note || ""}`);
      if (!v.ok) process.exitCode = 2;
      return;
    }
    await restore(work, dir, manifest);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => require("../server/db").pool.end().catch(() => {}));
}
module.exports = { main };
