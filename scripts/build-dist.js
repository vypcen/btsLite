#!/usr/bin/env node
// Сборка для клиентов (пилот и поставка): без исходного кода, тестов и инструментов разработчика.
//   node scripts/build-dist.js            → папка dist/ (её копирует Dockerfile.dist)
// Что делает:
//   - сервер и консольные скрипты собираются esbuild в отдельные файлы (библиотеки из node_modules — как есть),
//     сжимаются и запутываются javascript-obfuscator: разобрать и переделать проверку лицензии становится
//     заметно труднее (полностью защитить код, работающий у клиента, нельзя — главная защита в договоре);
//   - раскладка папок прежняя (dist/server/index.js, dist/server/migrations, dist/public…), поэтому все пути
//     внутри сервера работают как в обычном образе;
//   - в комплект не попадают: тесты, e2e, исходники интерфейса, scripts/license.js (выпуск ключей), .git, исходные карты.
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const Obfuscator = require("javascript-obfuscator");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist");
const pkg = require("../package.json");

// Точки входа: свой файл на каждую (у каждого — своя копия общих модулей)
const ENTRIES = [
  ["server/index.js", "server/index.js"],
  ["server/hash-worker.js", "server/hash-worker.js"], // запускается отдельным Worker из auth.js
  ["server/migrate.js", "server/migrate.js"], // npm run migrate
  ["scripts/backup.js", "scripts/backup.js"], // резервные копии и восстановление из консоли
  ["scripts/import.js", "scripts/import.js"], // перенос из TestRail, TestLink, Qase
];
// Копируются как есть
const COPY = [
  "server/migrations",
  "server/assets",
  "scripts/report.js", // отдаётся пользователям по /report.js — это открытый клиентский скрипт
  "scripts/playwright-reporter.js",
  "scripts/backup.sh",
  "scripts/backup.ps1",
  "docs",
  "README.md",
  "CHANGELOG.md",
  ".env.example",
  "LICENSE-EULA.md",
];

const OBFUSCATE = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: false,
  controlFlowFlattening: false, // замедляет сервер, а пользы мало
  deadCodeInjection: false,
  selfDefending: false, // ломается от любого форматирования — неудобно в поддержке
  renameGlobals: false,
  transformObjectKeys: false, // ключи объектов — это имена полей API и SQL, их трогать нельзя
  unicodeEscapeSequence: false,
  target: "node",
  sourceMap: false,
};

function copy(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return console.warn(`  нет ${rel} — пропущено`);
  fs.cpSync(src, path.join(OUT, rel), { recursive: true });
}

async function main() {
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const [from, to] of ENTRIES) {
    const r = await esbuild.build({
      entryPoints: [path.join(ROOT, from)],
      outfile: path.join(OUT, to),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      packages: "external",
      minify: true,
      legalComments: "none",
      sourcemap: false,
      write: false,
      logLevel: "warning",
    });
    const code = r.outputFiles[0].text;
    const out = Obfuscator.obfuscate(code, OBFUSCATE).getObfuscatedCode();
    fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
    fs.writeFileSync(path.join(OUT, to), "#!/usr/bin/env node\n" + out.replace(/^#!.*\n/, ""));
    console.log(`  ${to}  ${(out.length / 1024).toFixed(0)} КБ`);
  }
  for (const rel of COPY) copy(rel);

  // package.json только с тем, что нужно для запуска
  const dist = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: pkg.description,
    license: "SEE LICENSE IN LICENSE-EULA.md",
    main: "server/index.js",
    scripts: { start: "node server/index.js", migrate: "node server/migrate.js", import: "node scripts/import.js" },
    engines: pkg.engines,
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(dist, null, 2) + "\n");
  fs.copyFileSync(path.join(ROOT, "package-lock.json"), path.join(OUT, "package-lock.json"));
  console.log(`Готово: dist/ за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
