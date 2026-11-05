// Runs the real CLI as a child process against a small fake backend, with an isolated home folder.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "insighta.js");
const CALLBACK_PORT = 53799;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "insighta-cli-"));
const credentialsPath = path.join(home, ".insighta", "credentials.json");

let server, apiUrl;
let requests = [];
const user = { login: "test-user", role: "admin" };

function run(args, input = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, INSIGHTA_API_URL: apiUrl, INSIGHTA_CLI_CALLBACK_PORT: String(CALLBACK_PORT) },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdin.end(input);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

function saveCredentials(overrides = {}) {
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({ apiUrl, accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 60_000, user, ...overrides }));
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      requests.push({ method: req.method, url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const json = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/auth/github") {
        return json(200, { status: "success", data: { authorize_url: `https://github.com/login/oauth/authorize?state=state-1&redirect_uri=${url.searchParams.get("redirect_uri")}`, state: "state-1" } });
      }
      if (url.pathname === "/auth/github/callback") return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 90, data: { user } });
      if (url.pathname === "/auth/refresh") return json(200, { access_token: "access-2", refresh_token: "refresh-2", expires_in: 600 });
      if (url.pathname === "/api/v1/session/me") return json(200, { data: { user } });
      if (req.method === "DELETE") {
        if (url.pathname.endsWith("/missing")) return json(404, { status: "error", message: "Profile not found" });
        res.writeHead(204);
        return res.end();
      }
      return json(404, { message: "Route not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  fs.rmSync(path.join(home, ".insighta"), { recursive: true, force: true });
});

test("--help lists every documented command", async () => {
  const { code, output } = await run(["--help"]);
  assert.equal(code, 0);
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const documented = readme.split("```bash")[2].split("```")[0].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const helped = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("insighta "));
  assert.deepEqual(helped, documented);
});

test("login generates the PKCE verifier locally and only sends the challenge at start", async () => {
  const child = spawn(process.execPath, [BIN, "login", "--api", apiUrl, "--no-open"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, INSIGHTA_CLI_CALLBACK_PORT: String(CALLBACK_PORT) },
  });
  let output = "", answered = false;
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exit = new Promise((resolve) => child.on("exit", resolve));
  child.stdout.on("data", async (chunk) => {
    output += chunk;
    if (!answered && output.includes("authorize")) {
      answered = true;
      await fetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?code=github-code&state=state-1`);
    }
  });
  assert.equal(await exit, 0, output);

  const start = requests.find((request) => request.url.pathname === "/auth/github");
  const callback = requests.find((request) => request.url.pathname === "/auth/github/callback");
  assert.equal(start.url.searchParams.has("code_verifier"), false);
  assert.equal(callback.body.code, "github-code");
  assert.equal(crypto.createHash("sha256").update(callback.body.code_verifier).digest("base64url"), start.url.searchParams.get("code_challenge"));

  const saved = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  assert.equal(saved.codeVerifier, undefined);
  const remaining = (saved.expiresAt - Date.now()) / 1000;
  assert.ok(remaining > 80 && remaining <= 90, `expires_in not used: ${remaining}`);
});

test("refreshes an expired token and uses the returned expires_in", async () => {
  saveCredentials({ expiresAt: 0 });
  const { code } = await run(["whoami"]);
  assert.equal(code, 0);
  assert.deepEqual(requests.find((request) => request.url.pathname === "/auth/refresh").body, { refresh_token: "refresh-1" });
  assert.equal(requests.find((request) => request.url.pathname === "/api/v1/session/me").headers.authorization, "Bearer access-2");
  const remaining = (JSON.parse(fs.readFileSync(credentialsPath, "utf8")).expiresAt - Date.now()) / 1000;
  assert.ok(remaining > 590 && remaining <= 600, `expires_in not used: ${remaining}`);
});

const deleteRequests = () => requests.filter((request) => request.method === "DELETE");

test("profiles delete does nothing without confirmation", async () => {
  saveCredentials();
  for (const answer of ["n\n", "", "maybe\n"]) {
    const { code, output } = await run(["profiles", "delete", "profile-1"], answer);
    assert.equal(code, 0);
    assert.match(output, /Cancelled/);
  }
  assert.equal(deleteRequests().length, 0);
});

test("profiles delete runs after a yes answer", async () => {
  saveCredentials();
  const { code, output } = await run(["profiles", "delete", "profile-1"], "y\n");
  assert.equal(code, 0);
  assert.match(output, /Deleted/);
  assert.equal(deleteRequests()[0].url.pathname, "/api/v1/profiles/profile-1");
  assert.equal(deleteRequests()[0].headers["x-api-version"], "1");
});

test("profiles delete --yes skips the question", async () => {
  saveCredentials();
  const { code, output } = await run(["profiles", "delete", "profile-1", "--yes"]);
  assert.equal(code, 0);
  assert.doesNotMatch(output, /\[y\/N\]/);
  assert.equal(deleteRequests().length, 1);
});

test("profiles delete reports errors and requires an id", async () => {
  saveCredentials();
  const missing = await run(["profiles", "delete", "missing", "--yes"]);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Profile not found/);

  const noId = await run(["profiles", "delete"]);
  assert.equal(noId.code, 1);
  assert.match(noId.output, /requires an id/);
});
