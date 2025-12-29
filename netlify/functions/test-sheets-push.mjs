export async function handler() {
  const url = process.env.SHEETS_WEBAPP_URL;
  if (!url) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "Missing SHEETS_WEBAPP_URL" }),
    };
  }

  const payload = {
    secret: process.env.SHEETS_SECRET || "",
    generatedAt: new Date().toISOString(),
    bestOffer: {
      price: "1234.56",
      currency: "USD",
      itineraries: [
        { duration: "PT15H20M", stops: 1, carriers: ["LH"] },
        { duration: "PT14H25M", stops: 1, carriers: ["LX"] },
      ],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: res.ok,
      status: res.status,
      responseText: text.slice(0, 500), // preview
    }),
  };
}
