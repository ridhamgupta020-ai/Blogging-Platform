"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "Frontend");
// Build output must be anchored to this repository, not whichever directory
// the deploy runner happens to use as its current working directory.
const output = path.resolve(__dirname, "..", "dist");
const configuredApi = (process.env.FRONTEND_API_URL || "").trim().replace(/\/$/, "");
const requiredOutput = [
  "index.html",
  "css/style.css",
  "js/api.js",
  "js/platform.js",
  "images/1.jpg",
  "runtime-config.json"
];

console.log(`[build] working directory: ${process.cwd()}`);
console.log(`[build] repository root: ${root}`);
console.log(`[build] absolute output directory: ${output}`);

if (process.env.VERCEL && path.resolve(process.cwd()) !== root) {
  throw new Error(`Set Vercel Root Directory to the repository root (${root}); build ran from ${process.cwd()}.`);
}

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

// Clear only the output directory before copying; nothing removes dist after build.
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(source, "pages"), output, { recursive: true });
for (const directory of ["css", "js", "images"]) {
  fs.cpSync(path.join(source, directory), path.join(output, directory), { recursive: true });
}
fs.writeFileSync(path.join(output, "runtime-config.json"), JSON.stringify({ apiBaseUrl: configuredApi }) + "\n");

const missing = [];
for (const relativePath of requiredOutput) {
  const exists = fs.existsSync(path.join(output, relativePath));
  console.log(`[build] ${exists ? "OK" : "MISSING"}: ${path.join(output, relativePath)}`);
  if (!exists) missing.push(relativePath);
}
if (missing.length) {
  throw new Error(`Frontend build output is incomplete at ${output}. Missing: ${missing.join(", ")}`);
}

console.log(`Frontend built to ${output}${configuredApi ? ` with API ${new URL(configuredApi).origin}` : " using same-origin API paths"}.`);
