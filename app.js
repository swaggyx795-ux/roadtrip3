const statusPill = document.getElementById("statusPill");
const startLatInput = document.getElementById("startLat");
const startLonInput = document.getElementById("startLon");
const endLatInput = document.getElementById("endLat");
const endLonInput = document.getElementById("endLon");
const btnLoadRoute = document.getElementById("btnLoadRoute");
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnReset = document.getElementById("btnReset");
const speedVal = document.getElementById("speedVal");
const timeScale = document.getElementById("timeScale");
const timeScaleVal = document.getElementById("timeScaleVal");
const tripMiles = document.getElementById("tripMiles");
const etaVal = document.getElementById("etaVal");
const progressVal = document.getElementById("progressVal");
const mpgInput = document.getElementById("mpg");
const gasPriceInput = document.getElementById("gasPrice");
const fuelCost = document.getElementById("fuelCost");
const tempVal = document.getElementById("tempVal");
const feelsVal = document.getElementById("feelsVal");
const condVal = document.getElementById("condVal");
const wxUpdated = document.getElementById("wxUpdated");
const rain1h = document.getElementById("rain1h");
const snow1h = document.getElementById("snow1h");
const snow24h = document.getElementById("snow24h");
const wxNote = document.getElementById("wxNote");

const DEFAULT_SPEED_MPH = 75;
const DEFAULT_START = { lat: 37.7749, lon: -122.4194 };
const DEFAULT_END = { lat: 39.3211, lon: -120.3397 };
const METERS_PER_MILE = 1609.344;

let viewer;
let routeEntity;
let vehicleEntity;
let sampledPosition;
let routeDurationSeconds = 0;
let routeDistanceMeters = 0;

const weatherCodeMap = new Map([
  [0, "Clear"],
  [1, "Mainly clear"],
  [2, "Partly cloudy"],
  [3, "Overcast"],
  [45, "Fog"],
  [48, "Depositing rime fog"],
  [51, "Light drizzle"],
  [53, "Drizzle"],
  [55, "Heavy drizzle"],
  [61, "Light rain"],
  [63, "Rain"],
  [65, "Heavy rain"],
  [71, "Light snow"],
  [73, "Snow"],
  [75, "Heavy snow"],
  [77, "Snow grains"],
  [80, "Light showers"],
  [81, "Showers"],
  [82, "Heavy showers"],
  [85, "Light snow showers"],
  [86, "Snow showers"],
  [95, "Thunderstorm"],
  [96, "Thunderstorm (hail)"],
  [99, "Thunderstorm (heavy hail)"],
]);

function setStatus(message, tone = "info") {
  statusPill.textContent = message;
  statusPill.dataset.tone = tone;
}

function toNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setDefaults() {
  startLatInput.value = DEFAULT_START.lat;
  startLonInput.value = DEFAULT_START.lon;
  endLatInput.value = DEFAULT_END.lat;
  endLonInput.value = DEFAULT_END.lon;
  speedVal.textContent = DEFAULT_SPEED_MPH.toFixed(0);
  timeScaleVal.textContent = `${timeScale.value}×`;
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      return { cesiumIonToken: "", hasWeatherKey: false };
    }
    return await response.json();
  } catch {
    return { cesiumIonToken: "", hasWeatherKey: false };
  }
}

function buildViewer() {
  const osm = new Cesium.OpenStreetMapImageryProvider({
    url: "https://a.tile.openstreetmap.org/",
  });

  viewer = new Cesium.Viewer("cesiumContainer", {
    imageryProvider: osm,
    baseLayerPicker: false,
    sceneModePicker: false,
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
  });

  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.clock.onTick.addEventListener(updatePlaybackStats);
}

function clearRoute() {
  if (routeEntity) {
    viewer.entities.remove(routeEntity);
    routeEntity = null;
  }
  if (vehicleEntity) {
    viewer.entities.remove(vehicleEntity);
    vehicleEntity = null;
  }
  sampledPosition = null;
  routeDurationSeconds = 0;
  routeDistanceMeters = 0;
}

function updatePlaybackStats() {
  if (!sampledPosition || routeDurationSeconds <= 0) {
    progressVal.textContent = "—";
    etaVal.textContent = "—";
    return;
  }

  const elapsed = Cesium.JulianDate.secondsDifference(
    viewer.clock.currentTime,
    viewer.clock.startTime,
  );
  const clampedElapsed = Math.min(Math.max(elapsed, 0), routeDurationSeconds);
  const progress = (clampedElapsed / routeDurationSeconds) * 100;

  progressVal.textContent = progress.toFixed(1);

  const remaining = Math.max(routeDurationSeconds - clampedElapsed, 0);
  etaVal.textContent = formatDuration(remaining);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return "—";
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

function updateFuelCost() {
  if (!routeDistanceMeters) {
    fuelCost.textContent = "—";
    return;
  }
  const miles = routeDistanceMeters / METERS_PER_MILE;
  const mpg = Math.max(toNumber(mpgInput.value, 0), 1);
  const gasPrice = Math.max(toNumber(gasPriceInput.value, 0), 0);
  const cost = (miles / mpg) * gasPrice;
  fuelCost.textContent = cost.toFixed(2);
}

async function loadRoute() {
  clearRoute();
  setStatus("Loading route…");
  btnLoadRoute.disabled = true;

  const startLat = toNumber(startLatInput.value, DEFAULT_START.lat);
  const startLon = toNumber(startLonInput.value, DEFAULT_START.lon);
  const endLat = toNumber(endLatInput.value, DEFAULT_END.lat);
  const endLon = toNumber(endLonInput.value, DEFAULT_END.lon);

  startLatInput.value = startLat.toFixed(6);
  startLonInput.value = startLon.toFixed(6);
  endLatInput.value = endLat.toFixed(6);
  endLonInput.value = endLon.toFixed(6);

  try {
    const start = `${startLon},${startLat}`;
    const end = `${endLon},${endLat}`;
    const response = await fetch(`/api/route?start=${start}&end=${end}`);

    if (!response.ok) {
      throw new Error("Route API failed");
    }

    const data = await response.json();
    if (!data.routes || !data.routes.length) {
      throw new Error("No routes found");
    }

    const route = data.routes[0];
    const coords = route.geometry.coordinates;

    if (!coords || coords.length < 2) {
      throw new Error("Route geometry missing");
    }

    routeDistanceMeters = route.distance || 0;
    const miles = routeDistanceMeters / METERS_PER_MILE;
    tripMiles.textContent = miles.toFixed(1);

    const polylinePositions = coords.flatMap(([lon, lat]) => [lon, lat]);
    routeEntity = viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(polylinePositions),
        width: 4,
        material: Cesium.Color.CYAN.withAlpha(0.9),
      },
    });

    const startTime = Cesium.JulianDate.now();
    const speedMps = (DEFAULT_SPEED_MPH * METERS_PER_MILE) / 3600;

    sampledPosition = new Cesium.SampledPositionProperty();
    let currentTime = startTime;

    sampledPosition.addSample(
      currentTime,
      Cesium.Cartesian3.fromDegrees(coords[0][0], coords[0][1]),
    );

    routeDurationSeconds = 0;

    for (let i = 1; i < coords.length; i += 1) {
      const [prevLon, prevLat] = coords[i - 1];
      const [lon, lat] = coords[i];
      const startCarto = Cesium.Cartographic.fromDegrees(prevLon, prevLat);
      const endCarto = Cesium.Cartographic.fromDegrees(lon, lat);
      const geodesic = new Cesium.EllipsoidGeodesic(startCarto, endCarto);
      const segmentDistance = geodesic.surfaceDistance || 0;
      const segmentSeconds = segmentDistance / speedMps;

      routeDurationSeconds += segmentSeconds;
      currentTime = Cesium.JulianDate.addSeconds(
        currentTime,
        segmentSeconds,
        new Cesium.JulianDate(),
      );
      sampledPosition.addSample(
        currentTime,
        Cesium.Cartesian3.fromDegrees(lon, lat),
      );
    }

    const stopTime = Cesium.JulianDate.addSeconds(
      startTime,
      routeDurationSeconds,
      new Cesium.JulianDate(),
    );

    vehicleEntity = viewer.entities.add({
      availability: new Cesium.TimeIntervalCollection([
        new Cesium.TimeInterval({ start: startTime, stop: stopTime }),
      ]),
      position: sampledPosition,
      orientation: new Cesium.VelocityOrientationProperty(sampledPosition),
      box: {
        dimensions: new Cesium.Cartesian3(22.0, 9.0, 7.0),
        material: Cesium.Color.ORANGE.withAlpha(0.9),
      },
      path: {
        resolution: 1,
        width: 3,
        material: Cesium.Color.YELLOW.withAlpha(0.7),
      },
    });

    viewer.clock.startTime = startTime;
    viewer.clock.stopTime = stopTime;
    viewer.clock.currentTime = startTime;
    viewer.clock.multiplier = Number.parseFloat(timeScale.value);
    viewer.clock.shouldAnimate = false;

    viewer.trackedEntity = vehicleEntity;

    btnStart.disabled = false;
    btnPause.disabled = true;
    btnReset.disabled = false;
    setStatus("Route ready");
    updateFuelCost();
    await loadWeather(endLat, endLon);
  } catch (error) {
    clearRoute();
    tripMiles.textContent = "—";
    etaVal.textContent = "—";
    progressVal.textContent = "—";
    setStatus("Route error", "error");
    console.error(error);
  } finally {
    btnLoadRoute.disabled = false;
  }
}

function startPlayback() {
  if (!sampledPosition) {
    return;
  }
  viewer.clock.shouldAnimate = true;
  btnStart.disabled = true;
  btnPause.disabled = false;
}

function pausePlayback() {
  viewer.clock.shouldAnimate = false;
  btnStart.disabled = false;
  btnPause.disabled = true;
}

function resetPlayback() {
  if (!sampledPosition) {
    return;
  }
  viewer.clock.currentTime = viewer.clock.startTime;
  viewer.clock.shouldAnimate = false;
  btnStart.disabled = false;
  btnPause.disabled = true;
  updatePlaybackStats();
}

async function loadWeather(lat, lon) {
  if (!navigator.onLine) {
    wxNote.textContent = "Offline: weather updates paused.";
    return;
  }

  wxNote.textContent = "";

  try {
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lat}&longitude=${lon}` +
      "&current=temperature_2m,apparent_temperature,precipitation,snowfall,weather_code" +
      "&daily=snowfall_sum" +
      "&timezone=auto";

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Weather API error");
    }

    const data = await response.json();
    const current = data.current;

    if (!current) {
      throw new Error("Weather unavailable");
    }

    tempVal.textContent = `${current.temperature_2m}°C`;
    feelsVal.textContent = `${current.apparent_temperature}°C`;
    condVal.textContent =
      weatherCodeMap.get(current.weather_code) || "Unknown";
    rain1h.textContent = `${current.precipitation ?? 0} mm`;
    snow1h.textContent = `${current.snowfall ?? 0} cm`;

    const dailySnow = data.daily?.snowfall_sum?.[0];
    snow24h.textContent =
      typeof dailySnow === "number" ? `${dailySnow} cm` : "—";

    wxUpdated.textContent = new Date().toLocaleTimeString();
  } catch (error) {
    wxNote.textContent = "Weather unavailable.";
    console.warn(error);
  }
}

function handleTimeScale() {
  timeScaleVal.textContent = `${timeScale.value}×`;
  if (viewer) {
    viewer.clock.multiplier = Number.parseFloat(timeScale.value);
  }
}

function initEvents() {
  btnLoadRoute.addEventListener("click", loadRoute);
  btnStart.addEventListener("click", startPlayback);
  btnPause.addEventListener("click", pausePlayback);
  btnReset.addEventListener("click", resetPlayback);
  timeScale.addEventListener("input", handleTimeScale);
  mpgInput.addEventListener("input", updateFuelCost);
  gasPriceInput.addEventListener("input", updateFuelCost);

  window.addEventListener("online", () => {
    if (vehicleEntity) {
      loadWeather(
        toNumber(endLatInput.value, DEFAULT_END.lat),
        toNumber(endLonInput.value, DEFAULT_END.lon),
      );
    }
  });
}

async function init() {
  setDefaults();
  initEvents();

  const config = await loadConfig();
  if (config.cesiumIonToken) {
    Cesium.Ion.defaultAccessToken = config.cesiumIonToken;
  }

  buildViewer();
  setStatus("Ready");
}

init();
