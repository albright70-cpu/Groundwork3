// /api/311-search.js
// Multi-city version. Add a new city by adding one entry to CITY_CONFIG —
// no other code changes needed, as long as the city's 311 data is on Socrata.
//
// Usage: GET /api/311-search?city=sf&address=1+Market+St&radius=200&years=5
//        GET /api/311-search?city=nyc&address=350+5th+Ave,+New+York,+NY&radius=200&years=5

const CITY_CONFIG = {
  sf: {
    label: "San Francisco",
    domain: "data.sfgov.org",
    datasetId: "vw6y-z8j6",
    fields: {
      category: "service_name",
      subtype: "service_subtype",
      detail: "service_details",
      address: "address",
      requested: "requested_datetime",
      closed: "closed_date",
      status: "status_description",
      geometry: "point", // Point column used for within_circle()
    },
  },
  nyc: {
    label: "New York City",
    domain: "data.cityofnewyork.us",
    datasetId: "erm2-nwe9",
    fields: {
      category: "complaint_type",
      subtype: "descriptor",
      detail: "resolution_description", // may be sparsely populated; verify against live data
      address: "incident_address",
      requested: "created_date",
      closed: "closed_date",
      status: "status",
      geometry: "location", // Point column; confirm on the dataset's own API tab if this errors
    },
  },
  // Add more cities here, e.g.:
  // chicago: { label: "Chicago", domain: "data.cityofchicago.org", datasetId: "...", fields: {...} },
};

export default async function handler(req, res) {
  const { address, radius = "200", years = "5", city = "sf" } = req.query;

  const config = CITY_CONFIG[city];
  if (!config) {
    return res.status(400).json({
      error: `Unknown city '${city}'. Available: ${Object.keys(CITY_CONFIG).join(", ")}`,
    });
  }
  if (!address) {
    return res.status(400).json({ error: "Missing 'address' query parameter" });
  }

  try {
    // Step 1: geocode (same for every city — Nominatim is global)
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

    // Step 2: query this city's Socrata dataset, using its own field names
    const f = config.fields;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - parseInt(years, 10));
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const where =
      `within_circle(${f.geometry}, ${lat}, ${lon}, ${radius}) ` +
      `AND ${f.requested} > '${cutoffStr}'`;

    const soqlUrl =
      `https://${config.domain}/resource/${config.datasetId}.json` +
      `?$where=${encodeURIComponent(where)}` +
      `&$order=${f.requested} DESC` +
      `&$limit=500`;

    const caseRes = await fetch(soqlUrl);
    if (!caseRes.ok) {
      const errText = await caseRes.text();
      return res.status(502).json({
        error: `${config.label}'s 311 API request failed`,
        detail: errText.slice(0, 300), // trimmed for readability
      });
    }
    const cases = await caseRes.json();

    // Step 3: summarize, using this city's field mapping
    const byCategory = {};
    let totalDays = 0;
    let closedCount = 0;

    for (const c of cases) {
      const cat = c[f.category] || "Uncategorized";
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (c[f.requested] && c[f.closed]) {
        const days = (new Date(c[f.closed]) - new Date(c[f.requested])) / 86400000;
        totalDays += days;
        closedCount++;
      }
    }

    res.status(200).json({
      city: config.label,
      address_matched: geoData[0].display_name,
      lat, lon,
      radius_meters: parseInt(radius, 10),
      years_covered: parseInt(years, 10),
      total_cases: cases.length,
      avg_days_to_close: closedCount ? Math.round((totalDays / closedCount) * 10) / 10 : null,
      by_category: byCategory,
      cases: cases.map(c => ({
        service: c[f.category],
        subtype: c[f.subtype],
        detail: c[f.detail],
        address: c[f.address],
        requested: c[f.requested],
        closed: c[f.closed] || null,
        status: c[f.status],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
