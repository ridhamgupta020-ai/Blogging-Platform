"use strict";

const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(url && publishableKey && secretKey);

if (configured && !/^https:\/\//i.test(url)) {
  throw new Error("SUPABASE_URL must be an HTTPS URL.");
}

// These clients are server-only. Never import this module from Frontend/.
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const publicClient = configured ? createClient(url, publishableKey, options) : null;
const adminClient = configured ? createClient(url, secretKey, options) : null;

async function checkConnection() {
  if (!configured) return { configured: false, connected: false };
  const { error } = await adminClient.from("profiles").select("id", { head: true, count: "exact" });
  return { configured: true, connected: !error };
}

module.exports = { configured, publicClient, adminClient, checkConnection };
