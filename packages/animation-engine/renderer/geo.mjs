const radians = (degrees) => degrees * Math.PI / 180;
const clampLat = (lat) => Math.max(-85, Math.min(85, Number(lat) || 0));
const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + radians(clampLat(lat)) / 2));

export function decodeTopology(topology, objectName = 'countries') {
  const object = topology?.objects?.[objectName];
  if (!object || !Array.isArray(topology.arcs)) throw new Error('Bundled map geometry is invalid.');
  const [sx, sy] = topology.transform?.scale || [1, 1];
  const [tx, ty] = topology.transform?.translate || [0, 0];
  const decoded = topology.arcs.map((arc) => {
    let x = 0; let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
  const arc = (index) => index >= 0 ? decoded[index] : [...decoded[~index]].reverse();
  const ring = (indices) => indices.flatMap((index, position) => {
    const points = arc(index);
    return position ? points.slice(1) : points;
  });
  const polygons = [];
  const addGeometry = (geometry) => {
    if (geometry.type === 'Polygon') polygons.push(geometry.arcs.map(ring));
    else if (geometry.type === 'MultiPolygon') geometry.arcs.forEach((polygon) => polygons.push(polygon.map(ring)));
    else if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(addGeometry);
  };
  addGeometry(object);
  return polygons;
}

export function unwrapLongitudes(points, anchorLongitude = 0) {
  let previous = Number(anchorLongitude) || 0;
  return points.map(([longitude, latitude]) => {
    let lon = Number(longitude);
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    previous = lon;
    return [lon, clampLat(latitude)];
  });
}

export function shortestLongitude(from, to, progress) {
  let end = Number(to) || 0;
  const start = Number(from) || 0;
  while (end - start > 180) end -= 360;
  while (end - start < -180) end += 360;
  return start + (end - start) * progress;
}

export function projectPoint(point, camera, width, height, shift = 0) {
  let longitude = Number(point.lon ?? point[0]);
  const latitude = Number(point.lat ?? point[1]);
  while (longitude - camera.lon > 180) longitude -= 360;
  while (longitude - camera.lon < -180) longitude += 360;
  const worldWidth = width * camera.zoom;
  const scale = worldWidth / (2 * Math.PI);
  return [
    width / 2 + radians(longitude - camera.lon) * scale + shift * worldWidth,
    height / 2 - (mercatorY(latitude) - mercatorY(camera.lat)) * scale,
  ];
}

export function projectedRingPath(points, camera, width, height, shift = 0) {
  const unwrapped = unwrapLongitudes(points, camera.lon);
  if (!unwrapped.length) return '';
  const worldWidth = width * camera.zoom;
  const scale = worldWidth / (2 * Math.PI);
  const coordinates = unwrapped.map(([lon, lat]) => [
    width / 2 + radians(lon - camera.lon) * scale + shift * worldWidth,
    height / 2 - (mercatorY(lat) - mercatorY(camera.lat)) * scale,
  ]);
  return coordinates.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ') + ' Z';
}

export function projectedRoutePath(locations, camera, width, height) {
  if (!Array.isArray(locations) || locations.length < 2) return '';
  const points = unwrapLongitudes(locations.map((location) => [location.lon, location.lat]), camera.lon);
  const worldWidth = width * camera.zoom;
  const scale = worldWidth / (2 * Math.PI);
  return points.map(([lon, lat], index) => {
    const x = width / 2 + radians(lon - camera.lon) * scale;
    const y = height / 2 - (mercatorY(lat) - mercatorY(camera.lat)) * scale;
    return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}
