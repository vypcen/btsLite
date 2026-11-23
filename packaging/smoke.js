const assert = require("node:assert/strict");
const fs = require("node:fs");

const [phase, configPath] = process.argv.slice(2);
const base = "http://127.0.0.1:3002";
const password = "Smoke-Setup-2026";
let cookie = "";

async function call(method, route, data, expected) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(cookie && { cookie }), ...(data !== undefined && { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (expected !== undefined) assert.equal(response.status, expected, `${method} ${route}: ${text}`);
  const session = response.headers.getSetCookie().find((item) => /^(?:__Host-)?tb_session=/.test(item));
  if (session) cookie = session.split(";")[0];
  return { status: response.status, text };
}

async function ready() {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      if ((await call("GET", "/readyz")).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail("Installed app did not become ready");
}

async function main() {
  await ready();
  const title = await call("GET", "/", undefined, 200);
  assert.match(title.text, /<title>BlackCat Testing Community<\/title>/);

  if (phase === "install") {
    const config = fs.readFileSync(configPath, "utf8");
    const setupCode = config.match(/^SETUP_CODE=([a-f0-9]+)\r?$/m)?.[1];
    assert.ok(setupCode, "setup code was generated");
    await call("POST", "/api/auth/register", { login: "operator", name: "Operator", password, setupCode }, 201);
    const license = JSON.parse((await call("GET", "/api/eula", undefined, 200)).text);
    assert.equal(license.accepted, false);
    await call("POST", "/api/eula/accept", {}, 200);
    await call("POST", "/api/projects", { key: "SMK", name: "Installer smoke test" }, 201);

    const add = (login, role, expected) => call("POST", "/api/admin/users", { login, name: "Test User", password, role }, expected);
    await add("testuser", "tester", 201);
    await add("devuser", "developer", 201);
    await add("viewuser", "viewer", 201);
    const attempts = await Promise.all([add("fifthuser", "viewer"), add("sixthuser", "tester")]);
    assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
    await add("extrauser", "viewer", 409);
  } else if (phase === "upgrade") {
    await call("POST", "/api/auth/login", { login: "operator", password }, 200);
    const meta = await call("GET", "/api/state", undefined, 200);
    assert.ok(JSON.parse(meta.text).projects.some((project) => project.id === "SMK"));
  } else {
    throw new Error("Expected install or upgrade");
  }

  const license = await call("GET", "/api/admin/license", undefined, 200);
  assert.deepEqual(JSON.parse(license.text).seats, { used: 5, limit: 5 });
  console.log(`Community ${phase}: home page, PostgreSQL, five seats and project verified`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
