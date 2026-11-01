"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "Frontend");
// Vercel resolves outputDirectory relative to its configured Root Directory,
// which is also the working directory used for the build command.
const output = path.resolve(process.cwd(), "dist");
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

const requiredOutput = [
  "index.html",
  "css/style.css",
  "js/api.js",
  "js/platform.js",
  "images/1.jpg",
  "runtime-config.json"
];
const missing = requiredOutput.filter((relativePath) => !fs.existsSync(path.join(output, relativePath)));
if (missing.length) {
  throw new Error(`Frontend build output is incomplete at ${output}. Missing: ${missing.join(", ")}`);
}

console.log(`Frontend built to ${output}${configuredApi ? ` with API ${new URL(configuredApi).origin}` : " using same-origin API paths"}.`);
