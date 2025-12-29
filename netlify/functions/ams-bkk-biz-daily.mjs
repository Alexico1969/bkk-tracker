// netlify/functions/ams-bkk-biz-daily.mjs

const BASE_DEP = "2026-07-23";
const BASE_RET = "2026-08-11";
const FLEX_DAYS = 1; // +/- 1 day => 9 pairs
const ORIGIN = "AMS";
const DEST = "BKK";
const CURRENCY = "USD";
const ADULTS = 1;

const MAX_STOPS = 1; // nonstop or one-stop
const MAX_HOURS_PER_DIRECTION = 20;
const MAX_MINUTES = MAX_HOURS_PER_DIRECTION * 60;

const AMADEUS_HOST = () => {
  const env = (process.env.AMADEUS_ENV || "test").toLowerCase();
  return env === "prod"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";
};

// --- Token cache across warm invocations ---
let cachedToken = null;
let cachedTokenExp = 0;

function addDays(yyyy_mm_dd, delta) {
  const d = new Date(`${yyyy_mm_dd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function parseISODurationToMinutes(iso) {
  // e.g. "PT13H45M"
  // Minimal parser for PT#H#M
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!m) return Number.POSITIVE_INFINITY;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + mins;
}

function stopsForItinerary(itinerary) {
  // Stops ~= segments - 1
  const segs = itinerary?.segments?.length || 0;
  return Math.max(0, segs - 1);
}

function isOfferValid(offer) {
  const itineraries = offer?.itineraries || [];
  if (itineraries.length < 2) return false; // round-trip expected

  for (const itin of itineraries) {
    const durationMin = parseISODurationToMinutes(itin.duration);
    if (durationMin > MAX_MINUTES) return false;

    const stops = stopsForItinerary(itin);
    if (stops > MAX_STOPS) return false;
  }
  return true;
}

function offerTotalPriceNumber(offer) {
  const p = offer?.price?.grandTotal ?? offer?.price?.total;
  const n = Number(p);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExp - 10_000) return cachedToken;

  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET env vars");
  }

  const url = `${AMADEUS_HOST()}/v1/security/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`OAuth failed (${resp.status}): ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  cachedTokenExp = now + (data.expires_in || 1200) * 1000;
  return cachedToken;
}

async function searchOnePair({ departureDate, returnDate }, token) {
  const url = new URL(`${AMADEUS_HOST()}/v2/shopping/flight-offers`);
  url.searchParams.set("originLocationCode", ORIGIN);
  url.searchParams.set("destinationLocationCode", DEST);
  url.searchParams.set("departureDate", departureDate);
  url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", String(ADULTS));
  url.searchParams.set("travelClass", "BUSINESS");
  url.searchParams.set("currencyCode", CURRENCY);
  url.searchParams.set("max", "50");

  // ✅ Correct param name for Amadeus Flight Offers Search v2:
  url.searchParams.set("maxNumberOfStops", String(MAX_STOPS));

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: text, cheapestValid: null };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: 500, error: "Invalid JSON from Amadeus", cheapestValid: null };
  }

  const offers = Array.isArray(json?.data) ? json.data : [];

  const validOffers = offers.filter(isOfferValid);
  validOffers.sort((a, b) => offerTotalPriceNumber(a) - offerTotalPriceNumber(b));

  const cheapest = validOffers[0] || null;

  return {
    ok: true,
    status: 200,
    error: null,
    cheapestValid: cheapest
      ? {
          id: cheapest.id,
          price: {
            currency: cheapest?.price?.currency || CURRENCY,
            grandTotal: cheapest?.price?.grandTotal ?? cheapest?.price?.total,
          },
          itineraries: cheapest.itineraries,
          validatingAirlineCodes: cheapest.validatingAirlineCodes,
          lastTicketingDate: cheapest.lastTicketingDate,
        }
      : null,
  };
}

function buildDatePairs() {
  const pairs = [];
  for (let depDelta = -FLEX_DAYS; depDelta <= FLEX_DAYS; depDelta++) {
    for (let retDelta = -FLEX_DAYS; retDelta <= FLEX_DAYS; retDelta++) {
      pairs.push({
        departureDate: addDays(BASE_DEP, depDelta),
        returnDate: addDays(BASE_RET, retDelta),
        delta: { dep: depDelta, ret: retDelta },
      });
    }
  }
  return pairs;
}

// Simple concurrency limiter (keeps Netlify from timing out as easily)
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export const handler = async () => {
  const started = Date.now();
  try {
    const token = await getAccessToken();
    const pairs = buildDatePairs();

    // 9 searches; do them with concurrency 3 to reduce timeout risk
    const searches = await mapLimit(pairs, 3, async (p) => {
      const r = await searchOnePair(p, token);
      return {
        pair: {
          departureDate: p.departureDate,
          returnDate: p.returnDate,
          delta: p.delta,
        },
        ...r,
      };
    });

    // Find overall best across the 9 searches
    const allCheapest = searches
      .map((s) => s.cheapestValid)
      .filter(Boolean);

    allCheapest.sort((a, b) => Number(a.price.grandTotal) - Number(b.price.grandTotal));
    const bestOffer = allCheapest[0] || null;

    const payload = {
      route: { origin: ORIGIN, destination: DEST },
      cabin: "BUSINESS",
      constraints: {
        maxStops: MAX_STOPS,
        maxHoursPerDirection: MAX_HOURS_PER_DIRECTION,
        adults: ADULTS,
        currency: CURRENCY,
        baseDeparture: BASE_DEP,
        baseReturn: BASE_RET,
        flexibilityDays: FLEX_DAYS,
        searches: pairs.length,
      },
      bestOffer,
      searches,
      generatedAt: new Date().toISOString(),
      runtimeMs: Date.now() - started,
    };

    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        { ok: false, error: String(err?.message || err), generatedAt: new Date().toISOString() },
        null,
        2
      ),
    };
  }
};
