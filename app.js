// If model fails to load (network/CORS), fallback to a box
if (vehicleEntity.model && vehicleEntity.model.readyPromise) {
  vehicleEntity.model.readyPromise.catch(() => {
    viewer.entities.remove(vehicleEntity);
    vehicleEntity = viewer.entities.add({
      position: sampledPosition,
      orientation: new Cesium.VelocityOrientationProperty(sampledPosition),
      box: {
        dimensions: new Cesium.Cartesian3(20.0, 8.0, 6.0),
      }
    });
  });
} else {
  // Model property not available — fallback immediately
  viewer.entities.remove(vehicleEntity);
  vehicleEntity = viewer.entities.add({
    position: sampledPosition,
    orientation: new Cesium.VelocityOrientationProperty(sampledPosition),
    box: {
      dimensions: new Cesium.Cartesian3(20.0, 8.0, 6.0),
    }
  });
}
