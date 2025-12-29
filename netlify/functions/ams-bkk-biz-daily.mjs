// netlify/functions/bkk-tracker.mjs

const ORIGIN = "AMS";
const DEST = "BKK";

// Base dates you gave:
const BASE_DEPARTURE = "2026-07-23";
const BASE_RETURN = "2026-08-11";

// Constraints you gave:
const MAX_STOPS = 1;          // direct or one-stop
const MAX_HOURS = 20;         // per-direction itinerary duration must be < 20h
const ADULTS = 1;             // change if needed
const CURRENCY = "USD";       // change if you prefer EUR

function assertEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function addDays(yyyy_mm_dd, deltaDays) {
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Parses ISO8601 duration like "PT13H45M" -> minutes
function isoDurationToMinutes(iso) {
  // Simple robust parse for PT#H#M
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(iso || "");
  if (!m) return Number.POSITIVE_INFINITY;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + mins;
}

function buildDatePairs(baseDep, baseRet) {
  // ±1 day on each -> 9 pairs
  const deltas = [-1, 0, 1];
  const pairs = [];
  for (const dDep of deltas) {
    for (const dRet of deltas) {
      pairs.push({
        departureDate: addDays(baseDep, dDep),
        returnDate: addDays(baseRet, dRet),
        delta: { dep: dDep, ret: dRet },
      });
    }
  }
  return pairs;
}

async function fetchAmadeusToken({ env, clientId, clientSecret }) {
  const base = env === "prod" ? "https://api.amadeus.com" : "https://test.api.amadeus.com";
  const url = `${base}/v1/security/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Amadeus OAuth failed (${res.status}): ${txt}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("Amadeus OAuth: no access_token returned");
  return { token: data.access_token, base };
}

async function searchRoundTripOffers({ base, token, departureDate, returnDate }) {
  const url = new URL(`${base}/v2/shopping/flight-offers`);

  // Amadeus Flight Offers Search params:
  // - travelClass=BUSINESS
  // - maxNumberOfConnections=1 (0 or 1 stop)
  // - currencyCode
  // - max: keep low-ish for speed
  url.searchParams.set("originLocationCode", ORIGIN);
  url.searchParams.set("destinationLocationCode", DEST);
  url.searchParams.set("departureDate", departureDate);
  url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", String(ADULTS));
  url.searchParams.set("travelClass", "BUSINESS");
  url.searchParams.set("maxNumberOfConnections", String(MAX_STOPS));
  url.searchParams.set("currencyCode", CURRENCY);
  url.searchParams.set("max", "50");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, status: res.status, errorText: txt, data: null };
  }

  const data = await res.json();
  return { ok: true, status: res.status, errorText: null, data };
}

function offerPassesFilters(offer) {
  // For round-trip, Amadeus typically returns 2 itineraries (outbound + inbound).
  // Enforce duration < 20h for each itinerary.
  const itineraries = offer?.itineraries;
  if (!Array.isArray(itineraries) || itineraries.length < 2) return false;

  const maxMinutes = MAX_HOURS * 60;

  for (const it of itineraries) {
    const mins = isoDurationToMinutes(it.duration);
    if (!(mins < maxMinutes)) return false;
  }

  // Stops already limited by maxNumberOfConnections, but we can be extra-safe:
  // A "stop" ~= segments - 1
  for (const it of itineraries) {
    const segs = it?.segments || [];
    const stops = Math.max(0, segs.length - 1);
    if (stops > MAX_STOPS) return false;
  }

  return true;
}

function pickCheapestValidOffer(amadeusResponseJson) {
  const offers = amadeusResponseJson?.data;
  if (!Array.isArray(offers) || offers.length === 0) return null;

  let best = null;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (const offer of offers) {
    if (!offerPassesFilters(offer)) continue;

    const p = Number(offer?.price?.grandTotal);
    if (!Number.isFinite(p)) continue;

    if (p < bestPrice) {
      bestPrice = p;
      best = offer;
    }
  }

  return best;
}

// Simple concurrency limiter (keeps you from timing out)
async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

export const handler = async () => {
  try {
    const clientId = assertEnv("AMADEUS_CLIENT_ID");
    const clientSecret = assertEnv("AMADEUS_CLIENT_SECRET");
    const env = (process.env.AMADEUS_ENV || "test").toLowerCase();

    const { token, base } = await fetchAmadeusToken({ env, clientId, clientSecret });

    const pairs = buildDatePairs(BASE_DEPARTURE, BASE_RETURN);

    // 9 searches; do 3 at a time to avoid a 30s timeout.
    const searches = await runWithConcurrency(pairs, 3, async (pair) => {
      const resp = await searchRoundTripOffers({
        base,
        token,
        departureDate: pair.departureDate,
        returnDate: pair.returnDate,
      });

      if (!resp.ok) {
        return {
          pair,
          ok: false,
          status: resp.status,
          error: resp.errorText?.slice(0, 500) || "Unknown error",
          cheapestValid: null,
        };
      }

      const cheapest = pickCheapestValidOffer(resp.data);
      const cheapestPrice = cheapest ? Number(cheapest.price.grandTotal) : null;

      return {
        pair,
        ok: true,
        status: resp.status,
        offersReturned: Array.isArray(resp.data?.data) ? resp.data.data.length : 0,
        cheapestValid: cheapest
          ? {
              price: cheapestPrice,
              currency: cheapest.price.currency,
              outboundDuration: cheapest.itineraries?.[0]?.duration,
              inboundDuration: cheapest.itineraries?.[1]?.duration,
              // Keep only the essentials so response stays small:
              validatingAirlineCodes: cheapest.validatingAirlineCodes,
              id: cheapest.id,
            }
          : null,
        // If you want the raw offer, uncomment this (response may get big):
        // rawCheapestOffer: cheapest || null,
      };
    });

    // Pick the cheapest valid across all 9 date pairs
    let bestAcrossAll = null;
    let bestPrice = Number.POSITIVE_INFINITY;

    for (const s of searches) {
      if (!s.ok || !s.cheapestValid) continue;
      const p = Number(s.cheapestValid.price);
      if (Number.isFinite(p) && p < bestPrice) {
        bestPrice = p;
        bestAcrossAll = {
          departureDate: s.pair.departureDate,
          returnDate: s.pair.returnDate,
          price: s.cheapestValid.price,
          currency: s.cheapestValid.currency,
          outboundDuration: s.cheapestValid.outboundDuration,
          inboundDuration: s.cheapestValid.inboundDuration,
          validatingAirlineCodes: s.cheapestValid.validatingAirlineCodes,
          offerId: s.cheapestValid.id,
        };
      }
    }

    const output = {
      route: { origin: ORIGIN, destination: DEST },
      cabin: "BUSINESS",
      constraints: {
        maxStops: MAX_STOPS,
        maxHoursPerDirection: MAX_HOURS,
        adults: ADULTS,
        currency: CURRENCY,
        baseDeparture: BASE_DEPARTURE,
        baseReturn: BASE_RETURN,
        flexibilityDays: 1,
        searches: pairs.length,
      },
      bestOffer: bestAcrossAll,
      searches, // includes per-pair result summary
      generatedAt: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify(output, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          error: String(err?.message || err),
          hint:
            "Check Netlify env vars AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET / AMADEUS_ENV and ensure the function file exports `handler`.",
        },
        null,
        2
      ),
    };
  }
};

// Optional: If you want it to run daily automatically (no external cron needed),
// uncomment this block. It will run on Netlify's scheduler.
//
// export const config = {
//   schedule: "0 7 * * *", // daily 07:00 UTC (adjust later)
// };
