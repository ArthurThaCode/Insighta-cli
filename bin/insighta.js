#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { execFile } = require("child_process");

const CONFIG_DIR = path.join(os.homedir(), ".insighta");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const DEFAULT_API_URL = process.env.INSIGHTA_API_URL || "http://localhost:3000";

function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeCredentials(credentials) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

function removeCredentials() {
  if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}

function request(method, urlString, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : null;
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method,
        headers: {
          Accept: headers.Accept || "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = res.headers["content-type"] || "";
          const data = contentType.includes("application/json") && text ? JSON.parse(text) : text;
          if (res.statusCode >= 400) {
            reject(new Error(data && data.message ? data.message : `Request failed with ${res.statusCode}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

function apiUrl(credentials, args) {
  return (args.api || credentials.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
}

function normalizeAuth(data) {
  return {
    accessToken: data.access_token || data.accessToken || data.data?.accessToken,
    refreshToken: data.refresh_token || data.refreshToken || data.data?.refreshToken,
    expiresIn: data.expires_in || data.expiresIn || data.data?.expiresIn,
    user: data.user || data.data?.user,
  };
}

async function refreshIfNeeded(credentials) {
  if (!credentials.refreshToken) return credentials;
  if (Date.now() < (credentials.expiresAt || 0) - 20_000) return credentials;
  try {
    const data = await request("POST", `${credentials.apiUrl}/auth/refresh`, {
      body: { refresh_token: credentials.refreshToken },
    });
    const auth = normalizeAuth(data);
    const next = {
      ...credentials,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      user: auth.user || credentials.user,
      expiresAt: Date.now() + Number(auth.expiresIn || 180) * 1000,
    };
    writeCredentials(next);
    return next;
  } catch {
    removeCredentials();
    throw new Error("Session expired. Run `insighta login` again.");
  }
}

async function authedRequest(method, pathName, { args, body, raw = false } = {}) {
  let credentials = readCredentials();
  credentials.apiUrl = apiUrl(credentials, args || {});
  credentials = await refreshIfNeeded(credentials);
  if (!credentials.accessToken) throw new Error("Run `insighta login` first.");
  return request(method, `${credentials.apiUrl}${pathName}`, {
    token: credentials.accessToken,
    body,
    headers: { "X-API-Version": "1", ...(raw ? { Accept: "text/csv" } : {}) },
  });
}

function buildProfileQuery(args) {
  const query = new URLSearchParams();
  const aliases = { country: "country_id", age_group: "age_group", sort_by: "sort_by" };
  for (const key of ["page", "limit", "gender", "country", "country_id", "age_group", "min_age", "max_age", "sort_by", "order"]) {
    if (args[key]) query.set(aliases[key] || key, args[key]);
  }
  return query.toString();
}

function spinner(message) {
  process.stdout.write(`${message}...`);
  return () => process.stdout.write(" done\n");
}

function formatTable(rows) {
  if (!rows || !rows.length) {
    console.log("No profiles found.");
    return;
  }
  const columns = ["name", "gender", "age", "age_group", "country_id", "created_at"];
  const widths = Object.fromEntries(columns.map((column) => [column, Math.max(column.length, ...rows.map((row) => String(row[column] || "").length))]));
  console.log(columns.map((column) => column.toUpperCase().padEnd(widths[column])).join("  "));
  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] || "").padEnd(widths[column])).join("  "));
  }
}

function usage() {
  console.log(`Insighta CLI

Usage:
  insighta login [--api http://localhost:3000]
  insighta logout
  insighta whoami

  insighta profiles list [--gender male] [--country NG] [--age-group adult]
  insighta profiles list [--min-age 25] [--max-age 40] [--sort-by age] [--order desc]
  insighta profiles get <id>
  insighta profiles search "young males from nigeria"
  insighta profiles create --name "Harriet Tubman"
  insighta profiles export --format csv [--gender male] [--country NG]
`);
}

async function login(args, baseUrl) {
  const server = http.createServer();
  const callback = await new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Insighta login complete. You can close this tab.");
      resolve({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
      server.close();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const data = await request("GET", `${baseUrl}/auth/github?interface=cli&redirect_uri=${encodeURIComponent(redirectUri)}`);
        writeCredentials({ apiUrl: baseUrl, state: data.data.state, codeVerifier: data.data.code_verifier });
        console.log("Opening GitHub OAuth...");
        console.log(data.data.authorize_url);
        openBrowser(data.data.authorize_url);
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });

  const credentials = readCredentials();
  if (!callback.code || callback.state !== credentials.state) throw new Error("Invalid OAuth callback state.");
  const data = await request("POST", `${baseUrl}/auth/github/callback`, {
    body: { code: callback.code, state: callback.state, code_verifier: credentials.codeVerifier },
  });
  const auth = normalizeAuth(data);
  writeCredentials({
    apiUrl: baseUrl,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAt: Date.now() + Number(auth.expiresIn || 180) * 1000,
    user: auth.user,
  });
  console.log(`Logged in as @${auth.user.login || auth.user.username}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = readCredentials();
  const baseUrl = apiUrl(credentials, args);
  const [command, group, actionOrId] = args._;

  if (!command || command === "help" || command === "--help") return usage();
  if (command === "login") return login(args, baseUrl);
  if (command === "logout") {
    if (credentials.refreshToken) await request("POST", `${baseUrl}/auth/logout`, { body: { refresh_token: credentials.refreshToken } }).catch(() => {});
    removeCredentials();
    console.log("Logged out.");
    return;
  }
  if (command === "whoami" || command === "me") {
    const done = spinner("Fetching account");
    const data = await authedRequest("GET", "/api/v1/session/me", { args });
    done();
    console.log(JSON.stringify(data.data.user, null, 2));
    return;
  }

  if (command !== "profiles") return usage();

  if (group === "list" || !group) {
    const done = spinner("Fetching profiles");
    const data = await authedRequest("GET", `/api/v1/profiles?${buildProfileQuery(args)}`, { args });
    done();
    formatTable(data.data);
    console.log(`\nPage ${data.page}/${Math.max(data.total_pages, 1)} (${data.total} total)`);
    return;
  }

  if (group === "get") {
    if (!actionOrId) throw new Error("profiles get requires an id");
    const done = spinner("Fetching profile");
    const data = await authedRequest("GET", `/api/v1/profiles/${encodeURIComponent(actionOrId)}`, { args });
    done();
    console.log(JSON.stringify(data.data, null, 2));
    return;
  }

  if (group === "search") {
    const q = args._.slice(2).join(" ");
    if (!q) throw new Error("profiles search requires a query");
    const done = spinner("Searching profiles");
    const data = await authedRequest("GET", `/api/v1/profiles/search?q=${encodeURIComponent(q)}`, { args });
    done();
    formatTable(data.data);
    return;
  }

  if (group === "create") {
    if (!args.name) throw new Error('profiles create requires --name "Harriet Tubman"');
    const done = spinner("Creating profile");
    const data = await authedRequest("POST", "/api/v1/profiles", { args, body: { name: args.name } });
    done();
    console.log(JSON.stringify(data.data, null, 2));
    return;
  }

  if (group === "export") {
    const format = args.format || "csv";
    const query = buildProfileQuery(args);
    const separator = query ? "&" : "";
    const done = spinner("Exporting profiles");
    const csv = await authedRequest("GET", `/api/v1/profiles/export?${query}${separator}format=${format}`, { args, raw: true });
    const filename = args.out || `profiles_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    fs.writeFileSync(path.resolve(process.cwd(), filename), csv);
    done();
    console.log(`Saved ${filename}`);
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
