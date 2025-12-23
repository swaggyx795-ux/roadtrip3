export default async function handler(req, res) {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "Missing start or end" });
    }

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${encodeURIComponent(start)};${encodeURIComponent(end)}` +
      `?overview=full&geometries=geojson`;

    const upstream = await fetch(url, {
      headers: { "user-agent": "DriveGlobe/1.0" },
    });

    const text = await upstream.text();

    try {
      const json = JSON.parse(text);
      return res.status(upstream.ok ? 200 : upstream.status).json(json);
    } catch {
      return res.status(502).json({
        error: "OSRM returned non-JSON",
        sample: text.slice(0, 200),
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Route failed" });
  }
}
