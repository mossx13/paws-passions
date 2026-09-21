#!/usr/bin/env node
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(ROOT, "data");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || "";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ico": "image/x-icon"
};
let memory = { clients: [], gallery: [], subtitle: "", blockedDates: [], reviews: [] };
function loadMemory() {
  try {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    if (!memory.clients) memory.clients = [];
    if (!memory.gallery) memory.gallery = [];
    if (!memory.blockedDates) memory.blockedDates = [];
    if (memory.subtitle == null) memory.subtitle = "";
    if (!memory.reviews) memory.reviews = [];
  } catch (e) {
    memory = { clients: [], gallery: [], subtitle: "", blockedDates: [], reviews: [] };
    persist();
  }
}
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}
function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-File-Name, Stripe-Signature",
    "Cache-Control": "no-store"
  });
  res.end(body);
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function flattenStripe(obj, prefix, out) {
  Object.keys(obj).forEach((key) => {
    const next = prefix ? prefix + "[" + key + "]" : key;
    const val = obj[key];
    if (val == null) return;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (item && typeof item === "object") flattenStripe(item, next + "[" + i + "]", out);
        else out.append(next + "[" + i + "]", String(item));
      });
    } else if (typeof val === "object") {
      flattenStripe(val, next, out);
    } else {
      out.append(next, String(val));
    }
  });
}
function stripeApi(method, apiPath, params) {
  if (!STRIPE_SECRET) return Promise.reject(new Error("missing stripe key"));
  const body = new URLSearchParams();
  if (params) flattenStripe(params, "", body);
  const payload = body.toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.stripe.com",
      path: apiPath,
      method: method,
      headers: {
        Authorization: "Bearer " + STRIPE_SECRET,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch (e) { reject(e); return; }
        if (parsed.error) reject(new Error(parsed.error.message || "stripe error"));
        else resolve(parsed);
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
function verifyStripeSignature(header, raw) {
  if (!STRIPE_WEBHOOK || !header) return false;
  const parts = {};
  String(header).split(",").forEach((bit) => {
    const i = bit.indexOf("=");
    if (i < 0) return;
    const k = bit.slice(0, i);
    const v = bit.slice(i + 1);
    if (k === "t") parts.t = v;
    if (k === "v1" && !parts.v1) parts.v1 = v;
  });
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (age > 300) return false;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK).update(parts.t + "." + raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function findAppointment(meta) {
  let hit = null;
  (memory.clients || []).forEach((c) => {
    (c.appointments || []).forEach((a) => {
      if (hit) return;
      if (meta.appointmentId && a.id === meta.appointmentId) hit = { client: c, appt: a };
      else if (meta.invoiceNo && a.invoiceNo === meta.invoiceNo) hit = { client: c, appt: a };
    });
  });
  return hit;
}
function applyStripeEvent(event) {
  const obj = event.data && event.data.object ? event.data.object : {};
  const meta = obj.metadata || {};
  const hit = findAppointment(meta);
  if (!hit) return false;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (obj.payment_status === "paid" || obj.status === "complete") {
      hit.appt.payStatus = "deposit_paid";
      hit.appt.stripeSessionId = obj.id;
      hit.appt.stripePaymentIntent = obj.payment_intent || hit.appt.stripePaymentIntent || "";
      hit.appt.paidAt = new Date().toISOString();
      persist();
      return true;
    }
  }
  if (event.type === "payment_intent.succeeded") {
    hit.appt.payStatus = "deposit_paid";
    hit.appt.stripePaymentIntent = obj.id;
    hit.appt.paidAt = new Date().toISOString();
    persist();
    return true;
  }
  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed" || event.type === "payment_intent.payment_failed") {
    if (hit.appt.payStatus !== "deposit_paid") {
      hit.appt.payStatus = "pay_failed";
      persist();
    }
    return true;
  }
  return false;
}
function mergePaidFlags(incoming) {
  const paid = {};
  (memory.clients || []).forEach((c) => {
    (c.appointments || []).forEach((a) => {
      if (a.payStatus === "deposit_paid") paid[a.id] = a;
    });
  });
  (incoming || []).forEach((c) => {
    (c.appointments || []).forEach((a) => {
      if (paid[a.id]) {
        a.payStatus = paid[a.id].payStatus;
        a.stripeSessionId = paid[a.id].stripeSessionId;
        a.stripePaymentIntent = paid[a.id].stripePaymentIntent;
        a.paidAt = paid[a.id].paidAt;
      }
    });
  });
}
function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const target = path.normalize(path.join(ROOT, clean === "/" ? "index.html" : clean));
  if (!target.startsWith(ROOT)) return null;
  return target;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  if (url.pathname === "/api/time") {
    send(res, 200, JSON.stringify({ now: Date.now(), iso: new Date().toISOString() }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/pay/config" && req.method === "GET") {
    send(res, 200, JSON.stringify({ stripe: Boolean(STRIPE_SECRET) }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/db" && req.method === "GET") {
    send(res, 200, JSON.stringify(memory), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/checkout" && req.method === "POST") {
    try {
      if (!STRIPE_SECRET) {
        send(res, 501, JSON.stringify({ ok: false, error: "Set STRIPE_SECRET_KEY on the server." }), "application/json; charset=utf-8");
        return;
      }
      const payload = JSON.parse((await readRaw(req)).toString("utf8") || "{}");
      const deposit = Math.max(1, Math.round(Number(payload.deposit || 0)));
      const origin = (req.headers.origin || ("http://" + req.headers.host)).replace(/\/$/, "");
      const session = await stripeApi("POST", "/v1/checkout/sessions", {
        mode: "payment",
        success_url: origin + "/index.html?paid=1&invoice=" + encodeURIComponent(payload.invoiceNo || ""),
        cancel_url: origin + "/index.html?pay=cancel",
        customer_email: payload.email || undefined,
        client_reference_id: payload.appointmentId || payload.invoiceNo || "",
        metadata: {
          appointmentId: payload.appointmentId || "",
          clientId: payload.clientId || "",
          invoiceNo: payload.invoiceNo || ""
        },
        payment_intent_data: {
          metadata: {
            appointmentId: payload.appointmentId || "",
            clientId: payload.clientId || "",
            invoiceNo: payload.invoiceNo || ""
          }
        },
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: deposit * 100,
            product_data: {
              name: "Paws & Passions deposit",
              description: (payload.invoiceNo || "Sit") + " · half of sit total"
            }
          }
        }]
      });
      const hit = findAppointment({ appointmentId: payload.appointmentId, invoiceNo: payload.invoiceNo });
      if (hit) {
        hit.appt.stripeSessionId = session.id;
        hit.appt.payStatus = hit.appt.payStatus === "deposit_paid" ? "deposit_paid" : "checkout_open";
        persist();
      }
      send(res, 200, JSON.stringify({ ok: true, url: session.url, id: session.id }), "application/json; charset=utf-8");
    } catch (e) {
      send(res, 400, JSON.stringify({ ok: false, error: e.message || "checkout failed" }), "application/json; charset=utf-8");
    }
    return;
  }
  if (url.pathname === "/api/stripe/webhook" && req.method === "POST") {
    const rawBuf = await readRaw(req);
    const raw = rawBuf.toString("utf8");
    if (!verifyStripeSignature(req.headers["stripe-signature"], raw)) {
      send(res, 400, JSON.stringify({ ok: false, error: "bad signature" }), "application/json; charset=utf-8");
      return;
    }
    let event;
    try { event = JSON.parse(raw); } catch (e) {
      send(res, 400, JSON.stringify({ ok: false, error: "bad json" }), "application/json; charset=utf-8");
      return;
    }
    applyStripeEvent(event);
    send(res, 200, JSON.stringify({ received: true, type: event.type }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/media" && req.method === "POST") {
    const id = (url.searchParams.get("id") || ("media-" + Date.now().toString(36))).replace(/[^a-zA-Z0-9_-]/g, "");
    const rawName = url.searchParams.get("name") || req.headers["x-file-name"] || "photo.jpg";
    let ext = path.extname(String(rawName)).toLowerCase();
    const type = String(req.headers["content-type"] || "");
    if (!ext) ext = type.indexOf("video") === 0 ? ".mp4" : ".jpg";
    const allowed = { ".jpg": 1, ".jpeg": 1, ".png": 1, ".gif": 1, ".webp": 1, ".mp4": 1, ".webm": 1, ".mov": 1, ".heic": 1, ".m4v": 1 };
    if (!allowed[ext]) ext = type.indexOf("video") === 0 ? ".mp4" : ".jpg";
    const dir = path.join(DATA_DIR, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, id + ext);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 80 * 1024 * 1024) {
          send(res, 413, JSON.stringify({ ok: false, error: "too large" }), "application/json; charset=utf-8");
          return;
        }
        chunks.push(chunk);
      }
      fs.writeFileSync(dest, Buffer.concat(chunks));
      send(res, 200, JSON.stringify({ ok: true, id: id, src: "/data/uploads/" + id + ext, bytes: size }), "application/json; charset=utf-8");
    } catch (e) {
      send(res, 500, JSON.stringify({ ok: false }), "application/json; charset=utf-8");
    }
    return;
  }
  if (url.pathname === "/api/media" && req.method === "DELETE") {
    const id = String(url.searchParams.get("id") || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (id) {
      const dir = path.join(DATA_DIR, "uploads");
      try {
        fs.readdirSync(dir).forEach(function (name) {
          if (name.indexOf(id) === 0) fs.unlinkSync(path.join(dir, name));
        });
      } catch (e) { /* empty */ }
    }
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/db" && req.method === "PUT") {
    try {
      const incoming = JSON.parse((await readRaw(req)).toString("utf8"));
      mergePaidFlags(incoming.clients);
      memory = {
        clients: Array.isArray(incoming.clients) ? incoming.clients : memory.clients,
        gallery: Array.isArray(incoming.gallery) ? incoming.gallery : memory.gallery,
        subtitle: typeof incoming.subtitle === "string" ? incoming.subtitle : memory.subtitle,
        blockedDates: Array.isArray(incoming.blockedDates) ? incoming.blockedDates : (memory.blockedDates || []),
        reviews: Array.isArray(incoming.reviews) ? incoming.reviews : (memory.reviews || [])
      };
      persist();
      send(res, 200, JSON.stringify({ ok: true, clients: memory.clients.length }), "application/json; charset=utf-8");
    } catch (e) {
      send(res, 400, JSON.stringify({ ok: false, error: "bad json" }), "application/json; charset=utf-8");
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "no");
    return;
  }
  const file = safePath(url.pathname);
  if (!file) {
    send(res, 403, "no");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, "not found");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(file).pipe(res);
  });
});
loadMemory();
server.listen(PORT, "0.0.0.0", () => {
  console.log("Paws & Passions server on http://0.0.0.0:" + PORT);
  console.log("Webhook POST /api/stripe/webhook");
  console.log("Stripe key " + (STRIPE_SECRET ? "loaded" : "missing — set STRIPE_SECRET_KEY"));
});
