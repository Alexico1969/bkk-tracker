export async function handler() {
  const SHEETS_WEBAPP_URL = process.env.SHEETS_WEBAPP_URL; // your Apps Script Web App URL
  const SHEETS_SECRET = process.env.SHEETS_SECRET || "";   // must match your script property if you use it

  if (!SHEETS_WEBAPP_URL) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing env var SHEETS_WEBAPP_URL" })
    };
  }

  // Minimal payload that matches what your doPost expects
  const payload = {
    secret: SHEETS_SECRET,
    generatedAt: new Date().toISOString(),
    bestOffer: {
      price: "1234.56",
      currency: "USD",
      itineraries: [
        { duration: "PT15H20M", stops: 1, carriers: ["LH"], firstDeparture: "2026-07-23T16:55:00", lastArrival: "2026-07-24T14:15:00" },
        { duration: "PT14H25M", stops: 1, carriers: ["LX"], firstDeparture: "2026-08-11T12:50:00", lastArrival: "2026-08-11T22:15:00" }
      ]
    }
  };

  const res = await fetch(SHEETS_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  return {
    statusCode: res.ok ? 200 : 500,
    body: JSON.stringify({
      ok: res.ok,
      status: res.status,
      responseText: text
    })
  };
}
