// netlify/functions/ams-bkk-biz-daily.mjs
// Node 18+ on Netlify supports global fetch.

const BASES = {
  test: "https://test.api.amadeus.com",
  prod: "https://api.amadeus.com",
};

function isoDateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return isoDateUTC(dt);
}

// Amadeus durations look like "PT13H25M"
function parseISODurationToMinutes(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const mins = m[2] ? Number(m[2]) : 0;
  return hours * 60 + mins;
}

function stopsForItinerary(itin) {
  const segs = itin?.segments || [];
  return Math.max(0, segs.length - 1);
}

function cheapestValidFromOffers(offers, { maxStops, maxMinutesPerDirection }) {
  let best = null;

  for (const offer of offers || []) {
    const itineraries = offer?.itineraries || [];
    if (itineraries.length < 1) continue;

    // For round trips, Amadeus typically returns 2 itineraries (outbound + inbound)
    // We'll enforce constraints on ALL itineraries returned.
    let ok = true;

    for (const itin of itineraries) {
      const stops = stopsForItinerary(itin);
      if (stops > maxStops) {
        ok = false;
        break;
      }
      const durMin = parseISODurationToMinutes(itin?.duration);
      if (durMin == null || durMin > maxMinutesPerDirection) {
        ok = false;
        break;
      }
    }

    if (!ok) continue;

    const price = Number(offer?.price?.grandTotal);
    if (!Number.isFinite(price)) continue;

    if (!best || price < best.price) {
      best = {
        price,
        currency: offer?.price?.currency || null,
        offerId: offer?.id || null,
        // keep a small summary; full payload can be huge
        itineraries: itineraries.map((itin) => ({
          duration: itin?.duration || null,
          stops: stopsForItinerary(itin),
          segments: (itin?.segments || []).map((s) => ({
            carrier: s?.carrierCode || null,
            number: s?.number || null,
            from: s?.departure?.iataCode || null,
            to: s?.arrival?.iataCode || null,
            departAt: s?.departure?.at || null,
            arriveAt: s?.arrival?.at || null,
            duration: s?.duration || null,
          })),
        })),
      };
    }
  }

  return best;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function getAccessToken(baseUrl, clientId, clientSecret) {
  const tokenUrl = `${baseUrl}/v1/security/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetchWithTimeout(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth failed (${res.status}): ${text}`);

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`OAuth missing access_token: ${text}`);
  return json.access_token;
}

async function searchFlightOffers({
  baseUrl,
  token,
  origin,
  destination,
  departureDate,
  returnDate,
  adults,
  travelClass,
  currencyCode,
  max, // limit returned offers to keep payload small
}) {
  const url = new URL(`${baseUrl}/v2/shopping/flight-offers`);
  url.searchParams.set("originLocationCode", origin);
  url.searchParams.set("destinationLocationCode", destination);
  url.searchParams.set("departureDate", departureDate);
  url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", String(adults));
  url.searchParams.set("travelClass", travelClass);
  url.searchParams.set("currencyCode", currencyCode);
  url.searchParams.set("max", String(max));

  // NOTE: We are intentionally NOT sending maxNumberOfStops/maxNumberOfConnections.
  // We filter stops + duration locally.

  // Basic 429 backoff
  let attempt = 0;
  let waitMs = 500;

  while (true) {
    attempt += 1;
    const res = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const text = await res.text();

    if (res.status === 429 && attempt <= 4) {
      await sleep(waitMs);
      waitMs *= 2;
      continue;
    }

    if (!res.ok) {
      return { ok: false, status: res.status, error: text, offers: [] };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: 500, error: `Non-JSON response: ${text}`, offers: [] };
    }

    return { ok: true, status: 200, error: null, offers: json?.data || [] };
  }
}

export const handler = async () => {
  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  const env = (process.env.AMADEUS_ENV || "test").toLowerCase(); // "test" or "prod"

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        { error: "Missing AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET env vars" },
        null,
        2
      ),
    };
  }

  const baseUrl = BASES[env] || BASES.test;

  // Your constraints
  const origin = "AMS";
  const destination = "BKK";
  const adults = 1;
  const travelClass = "BUSINESS";
  const currencyCode = "USD";

  const baseDeparture = "2026-07-23";
  const baseReturn = "2026-08-11";
  const flexibilityDays = 1; // +/- 1 day
  const maxStops = 1; // direct or one-stop
  const maxHoursPerDirection = 20;
  const maxMinutesPerDirection = maxHoursPerDirection * 60;

  // Build 9 date pairs (dep -1..+1) x (ret -1..+1)
  const pairs = [];
  for (let dd = -flexibilityDays; dd <= flexibilityDays; dd++) {
    for (let rd = -flexibilityDays; rd <= flexibilityDays; rd++) {
      pairs.push({
        departureDate: addDays(baseDeparture, dd),
        returnDate: addDays(baseReturn, rd),
        delta: { dep: dd, ret: rd },
      });
    }
  }

  const started = Date.now();
  let token;
  try {
    token = await getAccessToken(baseUrl, clientId, clientSecret);
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(e?.message || e) }, null, 2),
    };
  }

  const searches = [];
  let bestOffer = null;

  // Keep it sequential + small delay to reduce 429s
  for (const p of pairs) {
    const r = await searchFlightOffers({
      baseUrl,
      token,
      origin,
      destination,
      departureDate: p.departureDate,
      returnDate: p.returnDate,
      adults,
      travelClass,
      currencyCode,
      max: 30,
    });

    const cheapestValid = r.ok
      ? cheapestValidFromOffers(r.offers, { maxStops, maxMinutesPerDirection })
      : null;

    if (cheapestValid) {
      if (!bestOffer || cheapestValid.price < bestOffer.price) {
        bestOffer = {
          ...cheapestValid,
          pair: { departureDate: p.departureDate, returnDate: p.returnDate, delta: p.delta },
        };
      }
    }

    searches.push({
      pair: { departureDate: p.departureDate, returnDate: p.returnDate, delta: p.delta },
      ok: r.ok,
      status: r.status,
      error: r.error,
      cheapestValid,
    });

    await sleep(250);
  }

  const payload = {
    repo: "bkk-tracker",
    route: { origin, destination },
    cabin: travelClass,
    constraints: {
      maxStops,
      maxHoursPerDirection,
      adults,
      currency: currencyCode,
      baseDeparture,
      baseReturn,
      flexibilityDays,
      searches: pairs.length,
    },
    bestOffer,
    searches,
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - started,
    env,
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(payload, null, 2),
  };
};


