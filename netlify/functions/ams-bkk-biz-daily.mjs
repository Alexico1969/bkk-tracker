// netlify/functions/ams-bkk-biz-daily.mjs
// Node 18+ (Netlify) — uses built-in fetch

// -------------------------
// OAuth token cache (warm instance)
// -------------------------
let AMADEUS_TOKEN = null;
let AMADEUS_TOKEN_EXPIRES_AT_MS = 0;

// -------------------------
// Helpers
// -------------------------

export const config = {
  schedule: "0 12 * * *" // daily 12:00 UTC
};


const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(obj, null, 2),
});

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Hard per-request timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 7500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Single 429 retry wrapper
async function fetchWith429Retry(url, options = {}, timeoutMs = 7500) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (res.status !== 429) return res;

  // one retry (respect Retry-After if present)
  const ra = res.headers.get("retry-after");
  const waitMs = ra ? Math.min(4000, Number(ra) * 1000) : 1200;
  await sleep(waitMs);

  return fetchWithTimeout(url, options, timeoutMs);
}

// Concurrency limiter (keeps total runtime down + avoids burst rate limits)
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  });

  await Promise.all(workers);
  return results;
}

function parseDurationToMinutes(iso) {
  // "PT15H20M" => 920
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso || "");
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = m[2] ? parseInt(m[2], 10) : 0;
  return h * 60 + min;
}

function addDays(yyyy_mm_dd, delta) {
  const d = new Date(`${yyyy_mm_dd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// -------------------------
// Amadeus
// -------------------------
function amadeusBaseUrl() {
  // Amadeus uses different hostnames for test vs prod
  const env = (process.env.AMADEUS_ENV || "test").toLowerCase();
  return env === "prod"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";
}

async function getAmadeusToken() {
  const now = Date.now();
  if (AMADEUS_TOKEN && now < AMADEUS_TOKEN_EXPIRES_AT_MS - 15_000) {
    return AMADEUS_TOKEN;
  }

  const clientId = envOrThrow("AMADEUS_CLIENT_ID");
  const clientSecret = envOrThrow("AMADEUS_CLIENT_SECRET");

  const url = `${amadeusBaseUrl()}/v1/security/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    7500
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Amadeus OAuth failed (${res.status}): ${t}`);
  }

  const data = await res.json();
  // Typical: { access_token, expires_in }
  AMADEUS_TOKEN = data.access_token;
  AMADEUS_TOKEN_EXPIRES_AT_MS = Date.now() + (data.expires_in || 900) * 1000;
  return AMADEUS_TOKEN;
}

async function searchOffersOnePair({
  origin,
  destination,
  departureDate,
  returnDate,
  adults,
  currency,
  cabin,
  max = 10, // <- your "max: 10"
}) {
  const token = await getAmadeusToken();

  const url = new URL(`${amadeusBaseUrl()}/v2/shopping/flight-offers`);
  url.searchParams.set("originLocationCode", origin);
  url.searchParams.set("destinationLocationCode", destination);
  url.searchParams.set("departureDate", departureDate);
  url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", String(adults));
  url.searchParams.set("currencyCode", currency);
  url.searchParams.set("travelClass", cabin);
  url.searchParams.set("nonStop", "false");
  url.searchParams.set("max", String(max));

  // NOTE:
  // Amadeus does NOT accept maxNumberOfStops / maxNumberOfConnections on this endpoint.
  // We filter stops ourselves after getting results.

  const res = await fetchWith429Retry(
    url.toString(),
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    },
    8000
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, status: res.status, error: text, data: null };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: 200, error: "Invalid JSON from Amadeus", data: null };
  }

  return { ok: true, status: 200, error: null, data };
}

// -------------------------
// Offer filtering + picking cheapest
// -------------------------
function summarizeOffer(offer) {
  const price = offer?.price?.total;
  const currency = offer?.price?.currency;
  const itineraries = (offer?.itineraries || []).map((it) => {
    const duration = it.duration;
    const durationMinutes = parseDurationToMinutes(duration);
    const segs = it.segments || [];
    const stops = Math.max(0, segs.length - 1);
    const carriers = Array.from(new Set(segs.map((s) => s.carrierCode).filter(Boolean)));
    const firstDeparture = segs[0]?.departure?.at || null;
    const lastArrival = segs[segs.length - 1]?.arrival?.at || null;

    return {
      duration,
      durationMinutes,
      stops,
      carriers,
      firstDeparture,
      lastArrival,
    };
  });

  return {
    id: offer?.id,
    price,
    currency,
    itineraries,
    bookingLinkHint: "Use Flight Offers Price + Create Orders for booking flow (not included).",
  };
}

function isValidOffer(summary, { maxStops, maxMinutesPerDirection }) {
  if (!summary?.price) return false;
  if (!Array.isArray(summary.itineraries) || summary.itineraries.length !== 2) return false;

  for (const it of summary.itineraries) {
    if (it.durationMinutes == null) return false;
    if (it.durationMinutes > maxMinutesPerDirection) return false;
    if (it.stops > maxStops) return false;
  }
  return true;
}

function pickCheapestValid(offers, constraints) {
  const summaries = (offers || []).map(summarizeOffer);
  const valids = summaries.filter((s) => isValidOffer(s, constraints));

  if (valids.length === 0) return null;

  valids.sort((a, b) => Number(a.price) - Number(b.price));
  return valids[0];
}

// -------------------------
// Google Sheets logging (Apps Script webhook)
// -------------------------
async function postToSheetsWebhook(payload) {
  const url = process.env.SHEETS_WEBAPP_URL;
  if (!url) return { ok: false, status: null, error: "No SHEETS_WEBAPP_URL set" };

  const secret = process.env.SHEETS_SECRET || ""; // optional shared secret

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, ...payload }),
    },
    6500
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, status: res.status, error: text };
  return { ok: true, status: res.status, error: null };
}

// -------------------------
// Handler
// -------------------------
export async function handler() {
  const origin = "AMS";
  const destination = "BKK";
  const cabin = "BUSINESS";

  // Your dates + flexibility
  const baseDeparture = "2026-07-23";
  const baseReturn = "2026-08-11";
  const flexibilityDays = 1; // +/- 1 day => 9 combos

  // Your constraints
  const constraints = {
    maxStops: 1, // direct or one-stop
    maxMinutesPerDirection: 20 * 60, // under 20h each direction
    adults: 1,
    currency: "USD",
  };

  // Build 9 date pairs
  const deltas = [-1, 0, 1];
  const pairs = [];
  for (const depD of deltas) {
    for (const retD of deltas) {
      pairs.push({
        departureDate: addDays(baseDeparture, depD),
        returnDate: addDays(baseReturn, retD),
        delta: { dep: depD, ret: retD },
      });
    }
  }

  const startedAt = Date.now();

  // Run with limited concurrency (fast but less spiky)
  const results = await mapLimit(pairs, 3, async (pair) => {
    const r = await searchOffersOnePair({
      origin,
      destination,
      departureDate: pair.departureDate,
      returnDate: pair.returnDate,
      adults: constraints.adults,
      currency: constraints.currency,
      cabin,
      max: 10,
    });

    if (!r.ok) {
      return {
        pair,
        ok: false,
        status: r.status,
        error: r.error,
        cheapestValid: null,
      };
    }

    const offers = r.data?.data || [];
    const cheapestValid = pickCheapestValid(offers, {
      maxStops: constraints.maxStops,
      maxMinutesPerDirection: constraints.maxMinutesPerDirection,
    });

    return {
      pair,
      ok: true,
      status: 200,
      error: null,
      cheapestValid,
    };
  });

  // Pick best across all pairs
  const allCheapest = results.map((x) => x.cheapestValid).filter(Boolean);
  let bestOffer = null;
  if (allCheapest.length) {
    allCheapest.sort((a, b) => Number(a.price) - Number(b.price));
    bestOffer = allCheapest[0];
  }

  const payload = {
    route: { origin, destination },
    cabin,
    constraints: {
      maxStops: constraints.maxStops,
      maxHoursPerDirection: 20,
      adults: constraints.adults,
      currency: constraints.currency,
      baseDeparture,
      baseReturn,
      flexibilityDays,
      searches: pairs.length,
    },
    bestOffer,
    searches: results.map((r) => ({
      pair: r.pair,
      ok: r.ok,
      status: r.status,
      error: r.error,
      cheapestValid: r.cheapestValid,
    })),
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - startedAt,
    env: (process.env.AMADEUS_ENV || "test").toLowerCase(),
  };

  // Log to Sheets (non-fatal if it fails)
  const sheetsRes = await postToSheetsWebhook({
    kind: "ams-bkk-biz-daily",
    generatedAt: payload.generatedAt,
    bestOffer: payload.bestOffer,
    constraints: payload.constraints,
  });
  payload.sheetsWrite = sheetsRes;

  return json(200, payload);
}
