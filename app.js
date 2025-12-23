// DriveGlobe — browser-only globe + realistic routing + real-time weather (when online)
//
// Frontend: CesiumJS via CDN
// Backend: Vercel Functions in /api (route + weather + config)

const DEFAULTS = {
  start: { lat: 37.7749, lon: -122.4194 },       // San Francisco
  end:   { lat: 39.3185, lon: -120.3291 },       // Donner Summit-ish (I-80 / Donner Pass area)
  mph: 75
};

const els = {
  statusPill: document.getElementById('statusPill'),
  startLat: document.getElementById('startLat'),
  startLon: document.getElementById('startLon'),
  endLat: document.getElementById('endLat'),
  endLon: document.getElementById('endLon'),
  btnLoadRoute: document.getElementById('btnLoadRoute'),
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnReset: document.getElementById('btnReset'),
  timeScale: document.getElementById('timeScale'),
  timeScaleVal: document.getElementById('timeScaleVal'),
  tripMiles: document.getElementById('tripMiles'),
  etaVal: document.getElementById('etaVal'),
  progressVal: document.getElementById('progressVal'),
  mpg: document.getElementById('mpg'),
  gasPrice: document.getElementById('gasPrice'),
  fuelCost: document.getElementById('fuelCost'),
  tempVal: document.getElementById('tempVal'),
  feelsVal: document.getElementById('feelsVal'),
  condVal: document.getElementById('condVal'),
  wxUpdated: document.getElementById('wxUpdated'),
  rain1h: document.getElementById('rain1h'),
  snow1h: document.getElementById('snow1h'),
  snow24h: document.getElementById('snow24h'),
  wxNote: document.getElementById('wxNote'),
};

els.startLat.value = DEFAULTS.start.lat;
els.startLon.value = DEFAULTS.start.lon;
els.endLat.value = DEFAULTS.end.lat;
els.endLon.value = DEFAULTS.end.lon;

function setStatus(text) {
  els.statusPill.textContent = text;
}

function fmtMaybeNum(n, suffix = '') {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n}${suffix}`;
}

function metersToMiles(m) {
  return m / 1609.344;
}

function secondsToHMS(sec) {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${r}s`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// --- Cesium setup ---
let viewer;
let routeEntity;
let vehicleEntity;
let sampledPosition;
let startTime;
let stopTime;
let routeInfo = null;     // { distanceMeters, durationSeconds, coordsLonLat: [[lon,lat],...] }
let lastWxFetchAt = 0;

async function init() {
  setStatus('Loading config…');

  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({ cesiumIonToken: '', hasWeatherKey: false }));

  if (cfg?.cesiumIonToken) {
    Cesium.Ion.defaultAccessToken = cfg.cesiumIonToken;
  }

  // Create viewer (terrain requires a Cesium ion token; if missing, we fall back gracefully)
  try {
    viewer = new Cesium.Viewer('cesiumContainer', {
      terrain: Cesium.Terrain.fromWorldTerrain(),
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false,
      shouldAnimate: false,
    });
  } catch (e) {
    // Fallback: no streamed terrain
    viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false,
      shouldAnimate: false,
    });
  }

  // Optional: buildings (nice near SF)
  try {
    const buildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(buildings);
  } catch {}

  // Camera: start near SF
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-122.4175, 37.655, 12000),
    orientation: { pitch: Cesium.Math.toRadians(-35) }
  });

  // Hook UI
  els.btnLoadRoute.addEventListener('click', onLoadRoute);
  els.btnStart.addEventListener('click', onStart);
  els.btnPause.addEventListener('click', onPause);
  els.btnReset.addEventListener('click', onReset);
  els.timeScale.addEventListener('input', onTimeScale);
  els.mpg.addEventListener('input', updateFuelEstimate);
  els.gasPrice.addEventListener('input', updateFuelEstimate);

  // Online/offline indicator
  function updateOnlinePill() {
    const online = navigator.onLine;
    const base = routeInfo ? (viewer.clock.shouldAnimate ? 'Driving' : 'Ready') : 'Idle';
    setStatus(`${base} • ${online ? 'Online' : 'Offline'}`);
    els.wxNote.textContent = online
      ? (cfg?.hasWeatherKey ? '' : 'No TWC API key set on the server. Weather is disabled until you add TWC_API_KEY.')
      : 'Offline: route keeps moving, but weather can’t update until you’re back online.';
  }
  window.addEventListener('online', updateOnlinePill);
  window.addEventListener('offline', updateOnlinePill);

  updateOnlinePill();
  setStatus(navigator.onLine ? 'Ready • Online' : 'Ready • Offline');

  // Weather polling
  setInterval(() => {
    if (!routeInfo || !vehicleEntity) return;
    if (!navigator.onLine) return;
    // Avoid spamming: poll every 30s
    const now = Date.now();
    if (now - lastWxFetchAt < 30000) return;
    lastWxFetchAt = now;
    updateWeatherAtCar().catch(() => {});
  }, 1000);
}

function onTimeScale() {
  const mult = Number(els.timeScale.value || 1);
  els.timeScaleVal.textContent = `${mult}×`;
  if (viewer) viewer.clock.multiplier = mult;
}

async function onLoadRoute() {
  const start = { lat: Number(els.startLat.value), lon: Number(els.startLon.value) };
  const end = { lat: Number(els.endLat.value), lon: Number(els.endLon.value) };

  if (![start.lat, start.lon, end.lat, end.lon].every(Number.isFinite)) {
    alert('Please enter valid numbers for lat/lon.');
    return;
  }

  setStatus('Routing…');
  els.btnLoadRoute.disabled = true;

  try {
    // Serverless proxy to OSRM
    const qs = new URLSearchParams({
      start: `${start.lon},${start.lat}`,
      end: `${end.lon},${end.lat}`,
    });
    const res = await fetch(`/api/route?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Route failed');

    const route = data?.routes?.[0];
    const coords = route?.geometry?.coordinates;
    if (!route || !Array.isArray(coords) || coords.length < 2) throw new Error('Bad route response');

    routeInfo = {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      coordsLonLat: coords,
    };

    // Draw route
    if (routeEntity) viewer.entities.remove(routeEntity);
    if (vehicleEntity) viewer.entities.remove(vehicleEntity);
    routeEntity = viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(coords.flat()),
        width: 4,
        clampToGround: true,
      }
    });

    // Build sampled position timeline at 75 mph (m/s)
    const speedMps = DEFAULTS.mph * 0.44704;

    sampledPosition = new Cesium.SampledPositionProperty();
    sampledPosition.setInterpolationOptions({
      interpolationDegree: 1,
      interpolationAlgorithm: Cesium.LinearApproximation,
    });

    startTime = Cesium.JulianDate.now();
    let t = Cesium.JulianDate.clone(startTime);

    // Add first point
    sampledPosition.addSample(t, Cesium.Cartesian3.fromDegrees(coords[0][0], coords[0][1], 0));

    let totalMeters = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = Cesium.Cartesian3.fromDegrees(coords[i-1][0], coords[i-1][1], 0);
      const b = Cesium.Cartesian3.fromDegrees(coords[i][0], coords[i][1], 0);
      const d = Cesium.Cartesian3.distance(a, b);
      totalMeters += d;

      const dt = d / speedMps; // seconds at 75 mph
      t = Cesium.JulianDate.addSeconds(t, dt, new Cesium.JulianDate());
      sampledPosition.addSample(t, b);
    }
    stopTime = Cesium.JulianDate.clone(t);

    // Vehicle entity (3D model if reachable; otherwise fallback to a simple box)
    const modelUrl = 'https://raw.githubusercontent.com/CesiumGS/cesium/master/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb';

    vehicleEntity = viewer.entities.add({
      position: sampledPosition,
      orientation: new Cesium.VelocityOrientationProperty(sampledPosition),
      model: {
        uri: modelUrl,
        minimumPixelSize: 64,
        maximumScale: 200,
      },
    });

    // If model fails to load (network/CORS), fallback to a box
    vehicleEntity.model.readyPromise.catch(() => {
      viewer.entities.remove(vehicleEntity);
      vehicleEntity = viewer.entities.add({
        position: sampledPosition,
        orientation: new Cesium.VelocityOrientationProperty(sampledPosition),
        box: {
          dimensions: new Cesium.Cartesian3(20.0, 8.0, 6.0),
          // default material (white)
        }
      });
    });

    // Configure clock
    viewer.clock.startTime = startTime.clone();
    viewer.clock.stopTime = stopTime.clone();
    viewer.clock.currentTime = startTime.clone();
    viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
    viewer.clock.multiplier = Number(els.timeScale.value || 1);
    viewer.clock.shouldAnimate = false;

    // Track the vehicle
    viewer.trackedEntity = vehicleEntity;

    // UI
    const miles = metersToMiles(routeInfo.distanceMeters);
    els.tripMiles.textContent = miles.toFixed(1);
    updateFuelEstimate();
    updateProgressUI();

    els.btnStart.disabled = false;
    els.btnPause.disabled = true;
    els.btnReset.disabled = false;

    setStatus(navigator.onLine ? 'Ready • Online' : 'Ready • Offline');

    // Fetch weather immediately
    if (navigator.onLine) {
      await updateWeatherAtCar().catch(() => {});
    }
  } catch (e) {
    alert(`Could not load route: ${e.message || e}`);
    setStatus('Ready');
  } finally {
    els.btnLoadRoute.disabled = false;
  }
}

function onStart() {
  if (!routeInfo) return;
  viewer.clock.shouldAnimate = true;
  els.btnStart.disabled = true;
  els.btnPause.disabled = false;
  setStatus(navigator.onLine ? 'Driving • Online' : 'Driving • Offline');

  // Keep UI updated while animating
  if (!viewer._driveglobeTick) {
    viewer._driveglobeTick = viewer.clock.onTick.addEventListener(() => {
      updateProgressUI();
      // Stop when done
      if (Cesium.JulianDate.greaterThanOrEquals(viewer.clock.currentTime, stopTime)) {
        viewer.clock.shouldAnimate = false;
        els.btnStart.disabled = false;
        els.btnPause.disabled = true;
        setStatus(navigator.onLine ? 'Arrived • Online' : 'Arrived • Offline');
      }
    });
  }
}

function onPause() {
  if (!routeInfo) return;
  viewer.clock.shouldAnimate = false;
  els.btnStart.disabled = false;
  els.btnPause.disabled = true;
  setStatus(navigator.onLine ? 'Ready • Online' : 'Ready • Offline');
}

function onReset() {
  if (!routeInfo) return;
  viewer.clock.currentTime = startTime.clone();
  viewer.clock.shouldAnimate = false;
  els.btnStart.disabled = false;
  els.btnPause.disabled = true;
  updateProgressUI();
  setStatus(navigator.onLine ? 'Ready • Online' : 'Ready • Offline');
}

function updateProgressUI() {
  if (!routeInfo) return;
  const totalSec = Cesium.JulianDate.secondsDifference(stopTime, startTime);
  const curSec = Cesium.JulianDate.secondsDifference(viewer.clock.currentTime, startTime);
  const p = clamp(curSec / totalSec, 0, 1);

  els.progressVal.textContent = (p * 100).toFixed(0);
  const remaining = (1 - p) * totalSec;
  els.etaVal.textContent = secondsToHMS(remaining);
}

function updateFuelEstimate() {
  if (!routeInfo) return;
  const mpg = Number(els.mpg.value);
  const price = Number(els.gasPrice.value);
  if (!Number.isFinite(mpg) || mpg <= 0) { els.fuelCost.textContent = '—'; return; }
  const miles = metersToMiles(routeInfo.distanceMeters);
  const gallons = miles / mpg;
  if (!Number.isFinite(price) || price <= 0) {
    els.fuelCost.textContent = gallons.toFixed(2);
    return;
  }
  const cost = gallons * price;
  els.fuelCost.textContent = cost.toFixed(2);
}

async function updateWeatherAtCar() {
  if (!vehicleEntity || !sampledPosition) return;

  const pos = vehicleEntity.position.getValue(viewer.clock.currentTime);
  if (!pos) return;
  const carto = Cesium.Cartographic.fromCartesian(pos);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);

  const qs = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), units: 'e' });
  const res = await fetch(`/api/weather?${qs.toString()}`);
  const data = await res.json();

  if (!res.ok) {
    els.wxNote.textContent = data?.error || 'Weather request failed.';
    return;
  }

  // Fields we care about (see TWC CoD data elements: temperature, feels like, precip, snow)
  const temp = data.temperature;
  const feels = data.temperatureFeelsLike;
  const phrase = data.wxPhraseLong || data.wxPhraseShort || data.narrative || '';
  const precip1h = data.precip1Hour;
  const snow1h = data.snow1Hour;
  const snow24h = data.snow24Hour;
  const obsUtc = data.obsTimeUtc;

  els.tempVal.textContent = (temp === null || temp === undefined) ? '—' : `${temp}°F`;
  els.feelsVal.textContent = (feels === null || feels === undefined) ? '—' : `${feels}°F`;
  els.condVal.textContent = phrase || '—';

  // units=e => precip in inches, snow in inches (1h) & inches (24h) per docs
  els.rain1h.textContent = (precip1h === null || precip1h === undefined) ? '—' : `${precip1h} in`;
  els.snow1h.textContent = (snow1h === null || snow1h === undefined) ? '—' : `${snow1h} in`;
  els.snow24h.textContent = (snow24h === null || snow24h === undefined) ? '—' : `${snow24h} in`;

  if (obsUtc) {
    const d = new Date(obsUtc * 1000);
    els.wxUpdated.textContent = d.toLocaleString();
  } else {
    els.wxUpdated.textContent = '—';
  }

  els.wxNote.textContent = '';
}

// Boot
init().catch(err => {
  console.error(err);
  setStatus('Error');
  alert('Failed to initialize. Check console.');
});
