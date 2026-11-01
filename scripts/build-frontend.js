"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "Frontend");
const output = path.join(root, "dist");
const configuredApi = (process.env.FRONTEND_API_URL || "").trim().replace(/\/$/, "");

if (process.env.VERCEL && !configuredApi) {
  throw new Error("Set FRONTEND_API_URL in Vercel to the deployed Render backend origin.");
}

if (configuredApi) {
  let parsed;
  try { parsed = new URL(configuredApi); } catch { throw new Error("FRONTEND_API_URL must be a valid absolute URL."); }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("FRONTEND_API_URL must be the backend origin only, without a path or query.");
  if (process.env.VERCEL && ["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("FRONTEND_API_URL must point to the deployed backend on Vercel, not localhost.");
  }
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("FRONTEND_API_URL must use HTTPS outside local development.");
  }
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(source, "pages"), output, { recursive: true });
for (const directory of ["css", "js", "images"]) {
  fs.cpSync(path.join(source, directory), path.join(output, directory), { recursive: true });
}
fs.writeFileSync(path.join(output, "runtime-config.json"), JSON.stringify({ apiBaseUrl: configuredApi }) + "\n");
console.log(`Frontend built to dist${configuredApi ? ` with API ${new URL(configuredApi).origin}` : " using same-origin API paths"}.`);
