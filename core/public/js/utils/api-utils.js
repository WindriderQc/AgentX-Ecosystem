/**
 * @file API and networking utility functions.
 */

const parseRetryAfterMs = (response) => {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = Date.parse(retryAfter);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
};

/**
 * Build JSON request headers
 * @param {object} additionalHeaders - Additional headers to merge
 * @returns {object} Headers object
 */
const buildJsonHeaders = (additionalHeaders = {}) => ({
  'Content-Type': 'application/json',
  ...additionalHeaders
});

/**
 * Generic GET request wrapper
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<any>} JSON response
 */
export const get = async (url, options = {}) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildJsonHeaders(options.headers),
      credentials: options.credentials || 'include',
      ...options
    });

    if (!response.ok) {
      const error = new Error(`HTTP error! status: ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response);
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const bodyPreview = (await response.text()).slice(0, 200);
      throw new Error(`Expected JSON but got '${contentType}'. Body preview: ${bodyPreview}`);
    }

    return await response.json();
  } catch (error) {
    console.error('API GET failed:', error);
    throw error;
  }
};

/**
 * Generic POST request wrapper
 * @param {string} url - The URL to fetch
 * @param {object} data - The data to send
 * @param {object} options - Fetch options
 * @returns {Promise<any>} JSON response
 */
export const post = async (url, data = {}, options = {}) => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildJsonHeaders(options.headers),
      body: JSON.stringify(data),
      credentials: options.credentials || 'include',
      ...options
    });

    if (!response.ok) {
      const error = new Error(`HTTP error! status: ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response);
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const bodyPreview = (await response.text()).slice(0, 200);
      throw new Error(`Expected JSON but got '${contentType}'. Body preview: ${bodyPreview}`);
    }

    return await response.json();
  } catch (error) {
    console.error('API POST failed:', error);
    throw error;
  }
};

/**
 * Gets the hostname from the current URL.
 * @returns {string} The hostname of the current window location.
 */
export const getHostIP = () => {
  return window.location.hostname;
};

/**
 * Fetches the user's location data based on their IP address by calling a proxy endpoint.
 * @returns {Promise<object>} A promise that resolves with the location data.
 */
export const ipLookUp = async () => {
  try {
    const response = await fetch('/api/v1/geolocation');
    if (!response.ok) {
      throw new Error(`Network response was not ok: ${response.statusText}`);
    }
    const data = await response.json();
    console.log('User\'s Location Data is ', data);
    console.log('User\'s Country', data.country);
    return data;
  } catch (error) {
    console.error('Failed to fetch user location:', error);
    throw error; // Re-throw the error for the caller to handle
  }
};

/**
 * Fetches the current location of the International Space Station (ISS).
 * @returns {Promise<object>} A promise that resolves with the ISS location data.
 */
export const getIssLocation = async () => {
  const ISS_API_URL = 'https://api.wheretheiss.at/v1/satellites/25544';
  try {
    const response = await fetch(ISS_API_URL);
    if (!response.ok) {
      throw new Error(`Network response was not ok: ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to fetch ISS location:', error);
    throw error;
  }
};



/**
 * Posts data to a URL using the fetch API.
 * Handles URL-encoded form data.
 *
 * @param {string} url - The URL to post data to.
 * @param {URLSearchParams|string} data - The data to post, typically as a URLSearchParams object or a query string.
 * @returns {Promise<any>} A promise that resolves with the response data.
 */
export const postData = async (url = '', data = '') => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: data.toString(), // Ensure data is a string
    });

    if (!response.ok) {
      // Attempt to get more detailed error info from the body
      const errorBody = await response.text();
      throw new Error(`Request failed with status ${response.status}: ${errorBody}`);
    }

    // Check if the response is JSON before trying to parse it
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }
    return await response.text();

  } catch (error) {
    console.error('Error in postData:', error);
    throw error;
  }
};
