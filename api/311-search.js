// /api/311-search.js
// Deploy this as a Vercel serverless function (or adapt for Netlify/Cloudflare Workers).
// No API keys needed — both services used here are free and open.
//
// Usage:  GET /api/311-search?address=123+Main+St,+San+Francisco,+CA&radius=200&years=5
//   address: any address, geocoded via OpenStreetMap Nominatim
//   radius:  search radius in meters (default 200)
//   years:   how many years of history to pull (default 5)

export default async function handler(req, res) {
  const { address, radius = "200", years = "5" } = req.query;

  if (!address) {
    return res.status(400).json({ error: "Missing 'address' query parameter" });
  }

  try {
    // Step 1: geocode the address with Nominatim (OpenStreetMap's free geocoder)
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
      { headers: { "User-Agent": "groundwork-311-lookup/1.0 (personal project)" } }
    );
    const geoData = await geoRes.json();

    if (!geoData.length) {
      return res.status(404).json({ error: "Could not geocode that address" });
    }

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);

    // Step 2: query SF's 311 dataset (Socrata SODA API) for cases within a radius,
    // using within_circle() — a built-in SoQL geospatial filter.
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - parseInt(years, 10));
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const where = `within_circle(point, ${lat}, ${lon}, ${radius}) AND requested_datetime > '${cutoffStr}'`;
    const soqlUrl =
      `https://data.sfgov.org/resource/vw6y-z8j6.json` +
      `?$where=${encodeURIComponent(where)}` +
      `&$order=requested_datetime DESC` +
      `&$limit=500`;

    const caseRes = await fetch(soqlUrl);
    if (!caseRes.ok) {
      return res.status(502).json({ error: "SF 311 API request failed" });
    }
    const cases = await caseRes.json();

    // Step 3: summarize — counts by category, and average resolution time
    const byCategory = {};
    let totalDays = 0;
    let closedCount = 0;

    for (const c of cases) {
      byCategory[c.service_name] = (byCategory[c.service_name] || 0) + 1;
      if (c.requested_datetime && c.closed_date) {
        const days =
          (new Date(c.closed_date) - new Date(c.requested_datetime)) / 86400000;
        totalDays += days;
        closedCount++;
      }
    }

    res.status(200).json({
      address_matched: geoData[0].display_name,
      lat, lon,
      radius_meters: parseInt(radius, 10),
      years_covered: parseInt(years, 10),
      total_cases: cases.length,
      avg_days_to_close: closedCount ? Math.round((totalDays / closedCount) * 10) / 10 : null,
      by_category: byCategory,
      cases: cases.map(c => ({
        service: c.service_name,
        subtype: c.service_subtype,
        detail: c.service_details,
        address: c.address,
        requested: c.requested_datetime,
        closed: c.closed_date || null,
        status: c.status_description,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

