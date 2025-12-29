// netlify/functions/ams-bkk-biz-daily.mjs

export const config = {
  schedule: "@daily", // Netlify Scheduled Functions
};

const ORIGIN = "AMS";
const DEST = "BKK";
const TRAVEL_CLASS = "BUSINESS";
const MAX_TOTAL_MINUTES = 20 * 60; // < 20 hours
const MAX_STOPS_PER_DIRECTION = 1; // direct or one-stop

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function baseUrl() {
  const env = (process.env.AMADEUS_ENV || "test").toLowerCase();
  return env === "prod" ? "https://api.amadeus.com" : "https://test.api.amadeus.com";
}

function parseISODurationToMinutes(iso) {
  // e.g. "PT11H25M"
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + mins;
}

function addDays(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildFlexiblePairs(depDate, retDate) {
  // ±1 day on both ends => 3x3 = 9 pairs
  const depOptions = [addDays(depDate, -1), depDate, addDays(depDate, +1)];
  const retOptions = [addDays(retDate, -1), retDate, addDays(retDate, +1)];
  const pairs = [];
  for (const d of depOptions) {
    for (const r of retOptions) {
      // Keep sane: return must be after departure (strictly)
      if (r > d) pairs.push({ departureDate: d, returnDate: r });
    }
  }
  return pairs;
}

async function amadeusToken() {
  const clientId = requireEnv("AMADEUS_CLIENT_ID");
  const clientSecret = requireEnv("AMADEUS_CLIENT_SECRET");

  const url = `${baseUrl()}/v1/security/oauth2/token`;
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OAuth failed (${res.status}): ${JSON.stringify(json)}`);
  }
  if (!json.access_token) throw new Error(`OAuth missing access_token: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function flightOffersSearch(token, { departureDate, returnDate }) {
  const url = new URL(`${baseUrl()}/v2/shopping/flight-offers`);
  url.searchParams.set("originLocationCode", ORIGIN);
  url.searchParams.set("destinationLocationCode", DEST);
  url.searchParams.set("departureDate", departureDate);
  url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", "1");
  url.searchParams.set("travelClass", TRAVEL_CLASS);
  url.searchParams.set("currencyCode", "USD");
  url.searchParams.set("max", "50"); // keep it bounded

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Amadeus returns useful error objects
    return { ok: false, error: { status: res.status, body: json }, data: null };
  }
  return { ok: true, error: null, data: json };
}

function offerIsAllBusiness(offer) {
  const tps = offer?.travelerPricings;
  if (!Array.isArray(tps) || tps.length === 0) return false;

  // Ensure every segment priced as BUSINESS
  for (const tp of tps) {
    const fds = tp?.fareDetailsBySegment;
    if (!Array.isArray(fds) || fds.length === 0) return false;
    for (const seg of fds) {
      if ((seg?.cabin || "").toUpperCase() !== "BUSINESS") return false;
    }
  }
  return true;
}

function offerMeetsStopsAndDuration(offer) {
  const itineraries = offer?.itineraries;
  if (!Array.isArray(itineraries) || itineraries.length !== 2) return false; // round-trip: 2 itineraries expected

  let totalMinutes = 0;

  for (const itin of itineraries) {
    const segments = itin?.segments;
    if (!Array.isArray(segments) || segments.length === 0) return false;

    const stops = segments.length - 1;
    if (stops > MAX_STOPS_PER_DIRECTION) return false;

    // Prefer Amadeus itinerary duration if present
    const itinMinutes = parseISODurationToMinutes(itin?.duration);
    if (itinMinutes != null) totalMinutes += itinMinutes;
    else {
      // fallback: sum segment durations if they exist (often they don’t)
      return false;
    }
  }

  return totalMinutes < MAX_TOTAL_MINUTES;
}

function offerPriceNumber(offer) {
  const v = offer?.price?.grandTotal ?? offer?.price?.total;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickCheapestValid(offers) {
  let best = null;

  for (const offer of offers) {
    if (!offerIsAllBusiness(offer)) continue;
    if (!offerMeetsStopsAndDuration(offer)) continue;

    const price = offerPriceNumber(offer);
    if (price == null) continue;

    if (!best || price < best.price) {
      best = {
        price,
        currency: offer?.price?.currency || "USD",
        offerId: offer?.id,
        validatingAirlineCodes: offer?.validatingAirlineCodes || [],
        itineraries: offer?.itineraries || [],
        raw: offer, // keep full offer for debugging; remove if you want
      };
    }
  }

  return best;
}

export const handler = async () => {
  try {
    // Your fixed target dates (with ±1 flexibility applied)
    const targetDeparture = "2026-07-23";
    const targetReturn = "2026-08-11";

    const datePairs = buildFlexiblePairs(targetDeparture, targetReturn);

    const token = await amadeusToken();

    const results = [];
    let bestOverall = null;

    for (const pair of datePairs) {
      const resp = await flightOffersSearch(token, pair);

      if (!resp.ok) {
        results.push({ pair, ok: false, error: resp.error });
        continue;
      }

      const offers = resp.data?.data || [];
      const bestForPair = pickCheapestValid(offers);

      results.push({
        pair,
        ok: true,
        offerCount: offers.length,
        bestForPair: bestForPair
          ? { price: bestForPair.price, currency: bestForPair.currency, offerId: bestForPair.offerId }
          : null,
      });

      if (bestForPair && (!bestOverall || bestForPair.price < bestOverall.price)) {
        bestOverall = { pair, ...bestForPair };
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        {
          route: `${ORIGIN}-${DEST} round-trip`,
          travelClass: TRAVEL_CLASS,
          constraints: {
            maxStopsPerDirection: MAX_STOPS_PER_DIRECTION,
            maxTotalHours: 20,
            departureFlexDays: 1,
            returnFlexDays: 1,
          },
          targetDates: { departure: targetDeparture, return: targetReturn },
          searchedPairs: datePairs,
          cheapestValidOffer: bestOverall
            ? {
                pair: bestOverall.pair,
                price: bestOverall.price,
                currency: bestOverall.currency,
                offerId: bestOverall.offerId,
                validatingAirlineCodes: bestOverall.validatingAirlineCodes,
                itineraries: bestOverall.itineraries,
              }
            : null,
          perPairSummary: results,
          generatedAtUtc: new Date().toISOString(),
        },
        null,
        2
      ),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        {
          error: String(err?.message || err),
          generatedAtUtc: new Date().toISOString(),
        },
        null,
        2
      ),
    };
  }
};
