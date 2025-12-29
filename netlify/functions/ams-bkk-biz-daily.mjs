// netlify/functions/bkk-biz-daily.mjs
// Node 18+ (Netlify) has global fetch.

const ENV = process.env.AMADEUS_ENV || "test";
const AMADEUS_BASE =
  ENV === "prod" ? "https://api.amadeus.com" : "https://test.api.amadeus.com";

const ORIGIN = "AMS";
const DEST = "BKK";
const CABIN = "BUSINESS";
const ADULTS = 1;
const CURRENCY = "USD";

const BASE_DEPARTURE = "2026-07-23";
const BASE_RETURN = "2026-08-11";
const FLEX_DAYS = 1; // +/- 1 day => 3x3 = 9 searches

const MAX_STOPS = 1;
const MAX_HOURS_PER_DIRECTION = 20;

// Keep results small to reduce time & bandwidth
const API_MAX_RESULTS = 30;

// Scheduled daily run (UTC). Change if you want.
// Example: 11:30 UTC = 6:30 AM New York (usually; DST shifts).
export const config = {
  schedule: "30 11 * * *",
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj, null, 2),
  };
}

function parseISODurationToMinutes(iso) {
  // Supports formats like "PT13H45M", "PT55M", "PT20H"
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(iso || "");
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + mins;
}

function addDays(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildDatePairs(baseDep, baseRet, flexDays) {
  const pairs = [];
  for (let depDelta = -flexDays; depDelta <= flexDays; depDelta++) {
    for (let retDelta = -flexDays; retDelta <= flexDays; retDelta++) {
      pairs.push({
        departureDate: addDays(baseDep, depDelta),
        returnDate: addDays(baseRet, retDelta),
        delta: { dep: depDelta, ret: retDelta },
      });
    }
  }
  return pairs;
}

async function fetchWithRetry(url, options, { retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt > retries) return res;

    // Exponential backoff + jitter
    const waitMs = Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function getAccessToken() {
  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing AMADEUS_CLIENT_ID or AMADEUS_CLIENT_SECRET env vars.");
  }

  const tokenUrl = `${AMADEUS_BASE}/v1/security/oauth2/token`;

  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);

  const res = await fetchWithRetry(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth failed (${res.status}): ${txt}`);
  }
  const data = JSON.parse(txt);
  return data.access_token;
}

function isOfferValid(offer) {
  // Offer has itineraries: [outbound, inbound] for return trips.
  const itineraries = offer?.itineraries;
  if (!Array.isArray(itineraries) || itineraries.length < 2) return false;

  for (const itin of itineraries.slice(0, 2)) {
    const segments = itin?.segments || [];
    const stops = Math.max(0, segments.length - 1);
    if (stops > MAX_STOPS) return false;

    // Prefer itinerary.duration ISO string
    const mins = parseISODurationToMinutes(itin?.duration);
    if (mins == null) return false;
    if (mins > MAX_HOURS_PER_DIRECTION * 60) return false;
  }

  // Cabin validation: Amadeus returns "travelerPricings" with fareDetailsBySegment
  // We'll accept the offer if ANY travelerPricing shows CABIN in fareDetailsBySegment
  const tps = offer?.travelerPricings || [];
  if (!Array.isArray(tps) || tps.length === 0) return false;

  const cabinOk = tps.some((tp) =>
    (tp.fareDetailsBySegment || []).every((fds) => (fds.cabin || "").toUpperCase() === CABIN)
  );
  return cabinOk;
}

function offerPriceNumber(offer) {
  const total = offer?.price?.grandTotal ?? offer?.price?.total;
  const n = total ? Number(total) : NaN;
  return Number.isFinite(n) ? n : null;
}

function summarizeOffer(offer) {
  const price = offer?.price?.grandTotal ?? offer?.price?.total ?? null;
  const currency = offer?.price?.currency ?? CURRENCY;

  const itineraries = (offer?.itineraries || []).slice(0, 2).map((itin) => {
    const mins = parseISODurationToMinutes(itin?.duration);
    const segments = itin?.segments || [];
    return {
      duration: itin?.duration ?? null,
      durationMinutes: mins,
      stops: Math.max(0, segments.length - 1),
      carriers: Array.from(new Set(segments.map((s) => s?.carrierCode).filter(Boolean))),
      firstDeparture: segments[0]?.departure?.at ?? null,
      lastArrival: segments[segments.length - 1]?.arrival?.at ?? null,
    };
  });

  return {
    id: offer?.id ?? null,
    price,
    currency,
    itineraries,
    bookingLinkHint: "Use Flight Offers Price + Create Orders for booking flow (not included).",
  };
}

async function searchOnePair(token, departureDate, returnDate) {
  const url = new URL(`${AMADEUS_BASE}/v2/shopping/flight-offers`);
  url.searchParams.set("originLocationCode", ORIGIN);
  url.searchParams.set("destinationLocationCode", DEST);
  url.searchParams.set("departureDate", departureDate);
  url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", String(ADULTS));
  url.searchParams.set("travelClass", CABIN);
  url.searchParams.set("currencyCode", CURRENCY);
  url.searchParams.set("max", String(API_MAX_RESULTS));
  // NOTE: nonStop=true would force direct only. You want direct OR one-stop, so we leave it off.

  const res = await fetchWithRetry(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text, cheapestValid: null };
    // 400s here usually mean invalid params; 429 means rate limit; 500s are transient.
  }

  const data = JSON.parse(text);
  const offers = Array.isArray(data?.data) ? data.data : [];

  // Filter then pick cheapest
  const valid = offers.filter(isOfferValid);

  valid.sort((a, b) => {
    const pa = offerPriceNumber(a) ?? Number.POSITIVE_INFINITY;
    const pb = offerPriceNumber(b) ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });

  const cheapest = valid[0] || null;
  return {
    ok: true,
    status: 200,
    error: null,
    cheapestValid: cheapest ? summarizeOffer(cheapest) : null,
  };
}

// Basic concurrency limiter to avoid 429 storms
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

export const handler = async () => {
  const started = Date.now();

  const pairs = buildDatePairs(BASE_DEPARTURE, BASE_RETURN, FLEX_DAYS);

  try {
    const token = await getAccessToken();

    // Concurrency 2 is a safe default to reduce 429 + still finish under timeout.
    const searches = await mapWithConcurrency(pairs, 2, async (p) => {
      const r = await searchOnePair(token, p.departureDate, p.returnDate);
      return {
        pair: {
          departureDate: p.departureDate,
          returnDate: p.returnDate,
          delta: p.delta,
        },
        ...r,
      };
    });

    // Find best across searches
    const candidates = searches
      .map((s) => s.cheapestValid)
      .filter(Boolean);

    candidates.sort((a, b) => {
      const pa = a?.price ? Number(a.price) : Number.POSITIVE_INFINITY;
      const pb = b?.price ? Number(b.price) : Number.POSITIVE_INFINITY;
      return pa - pb;
    });

    const best = candidates[0] || null;

    return json(200, {
      route: { origin: ORIGIN, destination: DEST },
      cabin: CABIN,
      constraints: {
        maxStops: MAX_STOPS,
        maxHoursPerDirection: MAX_HOURS_PER_DIRECTION,
        adults: ADULTS,
        currency: CURRENCY,
        baseDeparture: BASE_DEPARTURE,
        baseReturn: BASE_RETURN,
        flexibilityDays: FLEX_DAYS,
        searches: pairs.length,
      },
      bestOffer: best,
      searches,
      generatedAt: new Date().toISOString(),
      runtimeMs: Date.now() - started,
      env: ENV,
    });
  } catch (err) {
    return json(500, {
      error: String(err?.message || err),
      generatedAt: new Date().toISOString(),
      runtimeMs: Date.now() - started,
      env: ENV,
    });
  }
};
