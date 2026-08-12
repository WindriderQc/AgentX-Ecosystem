/**
 * @file Geolocation and mapping utility functions.
 */

/**
 * Converts degrees to radians.
 * @param {number} degrees - The angle in degrees.
 * @returns {number} The angle in radians.
 */
export const toRadians = (degrees) => {
  return degrees * (Math.PI / 180);
};

/**
 * Calculates the Haversine distance between two geographic coordinates.
 * @param {number} lat1 - Latitude of the first point.
 * @param {number} lon1 - Longitude of the first point.
 * @param {number} lat2 - Latitude of the second point.
 * @param {number} lon2 - Longitude of the second point.
 * @returns {number} The distance in kilometers.
 */
export const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return distance; // in kilometers
};

/**
 * Checks if the browser's Geolocation API is available.
 * @returns {boolean} True if geolocation is available, false otherwise.
 */
export const isGeoLocAvailable = () => {
  const isAvailable = 'geolocation' in navigator;
  console.log(isAvailable ? 'Geolocation is available.' : 'Geolocation is not available.');
  return isAvailable;
};

/**
 * Gets the user's current geographic position.
 * @returns {Promise<GeolocationPosition>} A promise that resolves with the position object or rejects with an error.
 */
export const geoLocate = () => {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation is not supported by this browser.'));
      return;
    }
    const options = {
      enableHighAccuracy: true,
      maximumAge: 0,
    };
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
};