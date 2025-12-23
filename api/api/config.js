export default function handler(req, res) {
  res.status(200).json({
    cesiumIonToken: process.env.CESIUM_ION_TOKEN || "",
    hasWeatherKey: Boolean(process.env.GMP_API_KEY),
  });
}
