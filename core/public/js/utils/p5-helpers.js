/**
 * @file Helper functions for use with the p5.js library.
 * @description These functions have a dependency on p5.js and expect to be used in an environment
 * where p5.js is loaded and its global functions (e.g., `width`, `height`, `radians`) are available.
 */

/**
 * Displays a grid on the p5.js canvas.
 * @param {p5} p - The p5 instance.
 * @param {number} r - The number of rows.
 * @param {number} l - The number of columns.
 * @param {p5.Color|number} [color=0] - The color of the grid lines.
 * @param {number} [weight=1] - The stroke weight of the grid lines.
 */
export const displayGrid = (p, r, l, color = 0, weight = 1) => {
  p.stroke(color);
  p.strokeWeight(weight);
  for (let x = -p.width / 2; x < p.width / 2; x += p.width / r) {
    p.line(x, -p.height / 2, x, p.height / 2);
  }
  for (let y = -p.height / 2; y < p.height / 2; y += p.height / l) {
    p.line(-p.width / 2, y, p.width / 2, y);
  }
};

/**
 * Calculates the Mercator projection X-coordinate.
 * @param {p5} p - The p5 instance.
 * @param {number} lon - The longitude.
 * @param {number} zoom - The zoom level.
 * @returns {number} The x-coordinate.
 */
export const mercX = (p, lon, zoom) => {
  lon = p.radians(lon);
  const a = (256 / Math.PI) * Math.pow(2, zoom);
  const b = lon + Math.PI;
  return a * b;
};

/**
 * Calculates the Mercator projection Y-coordinate.
 * @param {p5} p - The p5 instance.
 * @param {number} lat - The latitude.
 * @param {number} zoom - The zoom level.
 * @returns {number} The y-coordinate.
 */
export const mercY = (p, lat, zoom) => {
  lat = p.radians(lat);
  const a = (256 / Math.PI) * Math.pow(2, zoom);
  const b = Math.tan(Math.PI / 4 + lat / 2);
  const c = Math.PI - Math.log(b);
  return a * c;
};

/**
 * Gets the Mercator coordinates with an offset.
 * @param {p5} p - The p5 instance.
 * @param {number} lon - The longitude.
 * @param {number} lat - The latitude.
 * @param {number} zoom - The zoom level.
 * @param {number} [offsetx=0] - The longitude offset.
 * @param {number} [offsety=0] - The latitude offset.
 * @returns {{x: number, y: number}} The Mercator coordinates.
 */
export const getMercatorCoord = (p, lon, lat, zoom, offsetx = 0, offsety = 0) => {
  const cx = mercX(p, offsetx, zoom);
  const cy = mercY(p, offsety, zoom);
  const x = mercX(p, lon, zoom) - cx;
  const y = mercY(p, lat, zoom) - cy;
  return { x, y };
};

/**
 * Converts spherical coordinates to a 3D vector.
 * @param {p5} p - The p5 instance.
 * @param {number} rayon - The radius.
 * @param {number} latitude - The latitude.
 * @param {number} longitude - The longitude.
 * @returns {p5.Vector} A p5.Vector object representing the Cartesian coordinates.
 */
export const getSphereCoord = (p, rayon, latitude, longitude) => {
  const theta = p.radians(latitude);
  const phi = p.radians(longitude) + p.HALF_PI;
  const x = rayon * Math.cos(theta) * Math.cos(phi);
  const y = -rayon * Math.sin(theta);
  const z = -rayon * Math.cos(theta) * Math.sin(phi);
  return p.createVector(x, y, z);
};

/**
 * Converts 3D Cartesian coordinates back to latitude and longitude.
 * @param {p5} p - The p5 instance.
 * @param {number} x - The x-coordinate.
 * @param {number} y - The y-coordinate.
 * @param {number} z - The z-coordinate.
 * @param {number} rayon - The radius.
 * @returns {{lat: number, lon: number}} The latitude and longitude.
 */
export const getLatLonFromSphereCoord = (p, x, y, z, rayon) => {
  if (rayon === 0) return { lat: 0, lon: 0 };

  let valForAsin = -y / rayon;
  valForAsin = Math.max(-1.0, Math.min(1.0, valForAsin));
  const theta = Math.asin(valForAsin);
  const latDegrees = p.degrees(theta);

  let phi_offset_calc;
  if (Math.abs(Math.cos(theta)) < 0.00001) {
    phi_offset_calc = 0;
  } else {
    phi_offset_calc = Math.atan2(-z, x);
  }

  let lonRadians = phi_offset_calc - p.HALF_PI;
  while (lonRadians <= -Math.PI) lonRadians += 2 * Math.PI;
  while (lonRadians > Math.PI) lonRadians -= 2 * Math.PI;

  const lonDegrees = p.degrees(lonRadians);

  return { lat: latDegrees, lon: lonDegrees };
};