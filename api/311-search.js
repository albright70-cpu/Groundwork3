// /api/311-search.js
// Now supports TWO platforms: Socrata (SF, NYC) and ArcGIS (Chapel Hill,
// and much of the NC region, which standardized on Esri/ArcGIS instead).
//
// Usage is the same either way:
//   GET /api/311-search?city=sf&address=...
//   GET /api/311-search?city=chapelhill&address=...

const CITY_CONFIG = {
  sf: {
    label: "San Francisco",
    platform: "socrata",
    domain: "data.sfgov.org",
    datasetId: "vw6y-z8j6",
    fields: {
      category: "service_name", subtype: "service_subtype", detail: "service_details",
      address: "address", requested: "requested_datetime", closed: "closed_date",
      status: "status_description", geometry: "point",
    },
  },
  nyc: {
    label: "New York City",
    platform: "socrata",
    domain: "data.cityofnewyork.us",
    datasetId: "erm2-nwe9",
    fields: {
      category: "complaint_type", subtype: "descriptor", detail: "resolution_description",
      address: "incident_address", requested: "created_date", closed: "closed_date",
      status: "status", geometry: "location",
    },
  },
  chapelhill: {
    label: "Chapel Hill, NC",
    platform: "arcgis",
    // Confirmed live endpoint — found via search, not guessed.
    featureServerUrl: "https://services8.arcgis.com/fz3KpsKgK9InMjh8/arcgis/rest/services/Chapel_Hill_NC/FeatureServer/0",
    fields: {
      // NOTE: these field names are a best guess based on typical SeeClickFix
      // exports (issue_type / created_at / closed_at / address / status).
      // VERIFY against the real response before trusting this in production —
      // hit the URL above with ?f=json to see this layer's real field list.
      category: "issue_type",
      subtype: null,
      detail: "description",
      address: "address",
      requested: "created_at",
      closed: "closed_at",
      status: "status",
    },
  },
  // raleigh: real service-request data exists (data-wake.opendata.arcgis.com,
  // updated twice daily) but I couldn't confirm its exact FeatureServer URL
  // from search alone. To add it: open the dataset on data.raleighnc.gov,
  // find its ArcGIS Hub page, click "View API Resources" -> the FeatureServer
  // URL is listed there directly. Paste it in as featureServerUrl below,
  // following the chapelhill entry as a template.
};

async function geocode(address) {
  const geoRes = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
    { headers: { "User-Agent": "groundwork-311-lookup/1.0 (personal project)" } }
  );
  const geoData = await geoRes.json();
  if (!geoData.length) return null;
  return { lat: parseFloat(geoData[0].lat), lon: parseFloat(geoData[0].lon), display_name: geoData[0].display_name };
}

async function querySocrata(config, lat, lon, radius, years) {
  const f = config.fields;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - parseInt(years, 10));
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const where = `within_circle(${f.geometry}, ${lat}, ${lon}, ${radius}) AND ${f.requested} > '${cutoffStr}'`;
  const url =
    `https://${config.domain}/resource/${config.datasetId}.json` +
    `?$where=${encodeURIComponent(where)}&$order=${f.requested} DESC&$limit=500`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Socrata request failed: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();

  return rows.map(r => ({
    service: r[f.category], subtype: f.subtype ? r[f.subtype] : null, detail: r[f.detail],
    address: r[f.address], requested: r[f.requested], closed: r[f.closed] || null, status: r[f.status],
  }));
}

async function queryArcGIS(config, lat, lon, radius, years) {
  const f = config.fields;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - parseInt(years, 10));

  // ArcGIS spatial query: a point + a search distance, in meters, WGS84 (4326)
  const params = new URLSearchParams({
    f: "json",
    where: "1=1", // date filtering added below if the field name is confirmed
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: radius,
    units: "esriSRUnit_Meter",
    outFields: "*",
    resultRecordCount: "500",
  });

  const res = await fetch(`${config.featureServerUrl}/query?${params.toString()}`);
  if (!res.ok) throw new Error(`ArcGIS request failed: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();

  if (data.error) throw new Error(`ArcGIS error: ${data.error.message}`);

  const rows = (data.features || []).map(feat => feat.attributes);

  return rows.map(r => ({
    service: r[f.category], subtype: f.subtype ? r[f.subtype] : null, detail: r[f.detail],
    address: r[f.address], requested: r[f.requested], closed: r[f.closed] || null, status: r[f.status],
  }));
}

export default async function handler(req, res) {
  const { address, radius = "200", years = "5", city = "sf" } = req.query;

  const config = CITY_CONFIG[city];
  if (!config) {
    return res.status(400).json({ error: `Unknown city '${city}'. Available: ${Object.keys(CITY_CONFIG).join(", ")}` });
  }
  if (!address) {
    return res.status(400).json({ error: "Missing 'address' query parameter" });
  }

  try {
    const geo = await geocode(address);
    if (!geo) return res.status(404).json({ error: "Could not geocode that address" });

    let cases;
    if (config.platform === "socrata") {
      cases = await querySocrata(config, geo.lat, geo.lon, radius, years);
    } else if (config.platform === "arcgis") {
      cases = await queryArcGIS(config, geo.lat, geo.lon, radius, years);
    } else {
      return res.status(500).json({ error: `Unsupported platform '${config.platform}' for ${city}` });
    }

    const byCategory = {};
    let totalDays = 0, closedCount = 0;
    for (const c of cases) {
      const cat = c.service || "Uncategorized";
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (c.requested && c.closed) {
        totalDays += (new Date(c.closed) - new Date(c.requested)) / 86400000;
        closedCount++;
      }
    }

    res.status(200).json({
      city: config.label,
      address_matched: geo.display_name,
      lat: geo.lat, lon: geo.lon,
      radius_meters: parseInt(radius, 10),
      years_covered: parseInt(years, 10),
      total_cases: cases.length,
      avg_days_to_close: closedCount ? Math.round((totalDays / closedCount) * 10) / 10 : null,
      by_category: byCategory,
      cases,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
