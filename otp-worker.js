/**
 * Zapier Landing Page — Phone Verification Worker (OTP only)
 *
 * A trimmed, standalone verification service for the Zapier migration landing
 * page. It does ONE thing: verify a phone number by SMS via Twilio Verify.
 * (Unlike the webinar worker, it does NOT touch Zoom or GHL registration.)
 *
 * Routes:
 *   POST /otp/send    { phone, turnstile_token }     -> { success, status }
 *   POST /otp/verify  { phone, code }                -> { success, verified, token }
 *   OPTIONS           -> CORS preflight
 *
 * Required secrets (set in Cloudflare, never hardcoded):
 *   TWILIO_SID, TWILIO_AUTH, TWILIO_VERIFY_SID  — Twilio Verify credentials
 *
 * Optional (each activates only once its secret/binding is present):
 *   TURNSTILE_SECRET     — Cloudflare Turnstile secret; gates /otp/send vs bots
 *   VERIFY_TOKEN_SECRET  — HMAC secret; returns a signed 15-min proof on verify
 *   RL_KV (KV binding)   — per-IP / per-phone rate limiting (protects Twilio $$)
 *
 * Deploy:  wrangler deploy   (see wrangler.jsonc)
 */

export default {
  async fetch(request, env) {
    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    const path = new URL(request.url).pathname;
    if (path === "/otp/send") return handleOtpSend(request, env);
    if (path === "/otp/verify") return handleOtpVerify(request, env);
    if (path === "/lead") return handleLead(request, env);

    return json({ success: false, error: "Not found" }, 404);
  },
};

/**
 * POST /otp/send — send a verification code to a phone via Twilio Verify.
 * Body: { phone, turnstile_token }
 * Protected by Turnstile (bots) + per-phone/per-IP rate limits (SMS cost).
 */
async function handleOtpSend(request, env) {
  if (!twilioConfigured(env)) {
    return json({ success: false, error: "Twilio not configured" }, 500);
  }

  const body = await request.json().catch(() => null);
  const phone = formatPhone(body?.phone);
  if (!phone) {
    return json({ success: false, error: "Invalid phone number" }, 400);
  }

  const ip = clientIp(request);

  // Turnstile bot challenge (active only when TURNSTILE_SECRET is set).
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, body?.turnstile_token, ip);
    if (!ok) {
      return json({ success: false, error: "Verification challenge failed. Please refresh and try again." }, 403);
    }
  }

  // Rate limits (active only when RL_KV is bound) — protect the Twilio bill.
  if (!(await checkLimit(env, `otp:send:phone:${phone}`, LIMITS.otpSendPerPhone))) {
    return json({ success: false, error: "Too many code requests for this number. Please wait a bit." }, 429);
  }
  if (!(await checkLimit(env, `otp:send:ip:${ip}`, LIMITS.otpSendPerIp))) {
    return json({ success: false, error: "Too many code requests. Please wait a bit." }, 429);
  }

  const result = await twilioVerify(env, "Verifications", { To: phone, Channel: "sms" });
  if (!result.ok) {
    console.error("Twilio send failed", result.error); // detail server-side only
    return json({ success: false, error: "Couldn't send the code. Please try again." }, 502);
  }
  return json({ success: true, status: result.body.status });
}

/**
 * POST /otp/verify — check a code; on success issue a signed verification token.
 * Body: { phone, code }  → { success, verified, token }
 */
async function handleOtpVerify(request, env) {
  if (!twilioConfigured(env)) {
    return json({ success: false, error: "Twilio not configured" }, 500);
  }

  const body = await request.json().catch(() => null);
  const phone = formatPhone(body?.phone);
  const code = String(body?.code || "").trim();
  if (!phone) return json({ success: false, error: "Invalid phone number" }, 400);
  if (!/^\d{4,10}$/.test(code)) return json({ success: false, error: "Invalid code" }, 400);

  // Cap verify attempts per phone (brute-force protection).
  if (!(await checkLimit(env, `otp:verify:phone:${phone}`, LIMITS.otpVerifyPerPhone))) {
    return json({ success: false, error: "Too many attempts. Please wait a bit." }, 429);
  }

  const result = await twilioVerify(env, "VerificationCheck", { To: phone, Code: code });
  if (!result.ok) {
    console.error("Twilio verify failed", result.error);
    return json({ success: false, verified: false, error: "Verification failed. Please try again." }, 502);
  }
  if (result.body.status !== "approved") {
    return json({ success: false, verified: false, error: "Invalid or expired code" });
  }

  // Signed proof the phone was verified (15-min TTL). Send it with the lead so
  // your CRM/webhook handler can confirm the number was really verified.
  const token = env.VERIFY_TOKEN_SECRET ? await issueVerifyToken(env, phone) : "";
  return json({ success: true, verified: true, token });
}

/**
 * POST /lead — forward a captured lead (qualified or not) to the GHL inbound
 * webhook server-side, so the webhook URL stays out of the public page source.
 * Body: the full lead payload from the landing page. Returns { success }.
 */
async function handleLead(request, env) {
  if (!env.GHL_WEBHOOK_URL) {
    return json({ success: false, error: "Lead webhook not configured" }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  // Server-side Meta Conversions API Lead, for QUALIFIED leads only, sharing
  // the browser pixel's event_id so Meta dedupes the two. Best-effort: it runs
  // concurrently with the GHL forward and never blocks or fails the response.
  // Inert until META_PIXEL_ID + META_CAPI_TOKEN are set on the worker.
  const capi = body && body.qualified === "Yes"
    ? sendCapiLead(env, request, body)
    : Promise.resolve();

  let forwardOk = false;
  try {
    const res = await fetch(env.GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    forwardOk = res.ok;
    if (!res.ok) console.error("GHL lead forward failed", res.status);
  } catch (err) {
    console.error("GHL lead forward error", err);
  }

  await capi; // sendCapiLead logs its own errors and never throws

  return forwardOk
    ? json({ success: true })
    : json({ success: false, error: "Lead forward failed" }, 502);
}

// Meta Graph API version used for the Conversions API. Bump if it gets deprecated.
const META_API_VERSION = "v21.0";

// Normalize a US phone for Meta hashing: digits only, with country code, no "+".
function metaPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return "1" + d;
  if (d.length === 11 && d[0] === "1") return d;
  return d;
}

// SHA-256 hex of a string (Meta requires PII in user_data to be SHA-256 hashed).
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Send a server-side "Lead" event to the Meta Conversions API.
 * PII is normalized + SHA-256 hashed. Shares event_id with the browser pixel
 * for deduplication. Never throws (logs and returns on any error).
 */
async function sendCapiLead(env, request, body) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return; // not configured -> no-op
  try {
    const userData = {};
    if (body.email)     userData.em = [await sha256Hex(String(body.email).trim().toLowerCase())];
    const phone = metaPhone(body.phone);
    if (phone)          userData.ph = [await sha256Hex(phone)];
    if (body.firstName) userData.fn = [await sha256Hex(String(body.firstName).trim().toLowerCase())];
    if (body.lastName)  userData.ln = [await sha256Hex(String(body.lastName).trim().toLowerCase())];

    const ip = request.headers.get("CF-Connecting-IP");
    const ua = request.headers.get("User-Agent");
    if (ip) userData.client_ip_address = ip;
    if (ua) userData.client_user_agent = ua;
    if (body.fbp) userData.fbp = body.fbp;   // _fbp cookie (browser pixel)
    if (body.fbc) userData.fbc = body.fbc;   // _fbc cookie / derived from fbclid

    const event = {
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      action_source: "website",
      event_id: body.eventId || undefined,                                   // dedup with browser pixel
      event_source_url: body.sourceUrl || request.headers.get("Referer") || undefined,
      user_data: userData,
    };
    const payload = { data: [event] };
    if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE; // optional, for Test Events

    const url = `https://graph.facebook.com/${META_API_VERSION}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("Meta CAPI Lead failed", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Meta CAPI Lead error", err);
  }
}

/**
 * Call a Twilio Verify endpoint with Basic auth + form-encoded params.
 * `endpoint` is "Verifications" (send) or "VerificationCheck" (check).
 */
async function twilioVerify(env, endpoint, params) {
  const auth = btoa(`${env.TWILIO_SID}:${env.TWILIO_AUTH}`);
  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SID}/${endpoint}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    }
  );

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    return { ok: false, error: data.message || `Twilio ${res.status}` };
  }
  return { ok: true, body: data };
}

// Normalize a US phone to E.164 (+1XXXXXXXXXX). Returns null if not 10/11 digits.
function formatPhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ============================ SECURITY HELPERS ============================

function twilioConfigured(env) {
  return env.TWILIO_SID && env.TWILIO_AUTH && env.TWILIO_VERIFY_SID;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// Per-key sliding-window counters. Rate limits are INACTIVE until RL_KV is bound.
const LIMITS = {
  otpSendPerPhone: { window: 3600, max: 3 },    // 3 codes/hr to a number
  otpSendPerIp: { window: 3600, max: 5 },        // 5 codes/hr from an IP
  otpVerifyPerPhone: { window: 3600, max: 10 },  // 10 verify tries/hr per number
};

async function checkLimit(env, key, { window, max }) {
  if (!env.RL_KV) return true; // inactive until the KV namespace is bound
  try {
    const bucket = Math.floor(Date.now() / 1000 / window);
    const fullKey = `${key}:${bucket}`;
    const current = parseInt((await env.RL_KV.get(fullKey)) || "0", 10);
    if (current >= max) return false;
    await env.RL_KV.put(fullKey, String(current + 1), { expirationTtl: window + 60 });
    return true;
  } catch {
    return true; // fail open — never block real users on a KV hiccup
  }
}

// Verify a Cloudflare Turnstile token server-side.
async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    return data.success === true;
  } catch {
    return false;
  }
}

// --- Signed phone-verification token (HMAC-SHA256, base64url) ---
function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeStr(str) {
  return b64url(new TextEncoder().encode(str));
}
async function hmacSign(secret, dataStr) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataStr));
  return b64url(sig);
}
async function issueVerifyToken(env, phone) {
  const payload = b64urlEncodeStr(JSON.stringify({ phone, exp: Date.now() + 15 * 60 * 1000 }));
  const sig = await hmacSign(env.VERIFY_TOKEN_SECRET, payload);
  return payload + "." + sig;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}
