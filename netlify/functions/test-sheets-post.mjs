export async function handler() {
  const SHEETS_WEBAPP_URL = process.env.SHEETS_WEBAPP_URL; // your Apps Script "web app" URL
  const SHEETS_SECRET = process.env.SHEETS_SECRET || "";   // must match script property if you set one

  if (!SHEETS_WEBAPP_URL) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing SHEETS_WEBAPP_URL env var" }),
    };
  }

  // Fake payload shaped like what your Apps Script expects
  const payload = {
    secret: SHEETS_SECRET,
    generatedAt: new Date().toISOString(),
    bestOffer: {
      price: "2430.20",
      currency: "USD",
      itineraries: [
        {
          duration: "PT15H20M",
          durationMinutes: 920,
          stops: 1,
          carriers: ["LH"],
          firstDeparture: "2026-07-22T16:55:00",
          lastArrival: "2026-07-23T14:15:00",
        },
        {
          duration: "PT14H25M",
          durationMinutes: 865,
          stops: 1,
          carriers: ["LX"],
          firstDeparture: "2026-08-10T12:50:00",
          lastArrival: "2026-08-10T22:15:00",
        },
      ],
    },
  };

  const res = await fetch(SHEETS_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        ok: res.ok,
        status: res.status,
        responseText: text,
        sent: payload,
      },
      null,
      2
    ),
  };
}
