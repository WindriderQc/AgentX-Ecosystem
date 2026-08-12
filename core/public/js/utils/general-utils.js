/**
 * @file General-purpose utility functions.
 */

/**
 * Logs an error message to the console.
 * @param {Error} err - The error object.
 */
export const cliError = (err) => {
  console.error(`ERROR(${err.code}): ${err.message}`);
};

/**
 * Logs a warning message to the console.
 * @param {object} warn - The warning object.
 * @param {string} warn.code - The warning code.
 * @param {string} warn.message - The warning message.
 */
export const cliWarning = (warn) => {
  console.warn(`WARNING(${warn.code}): ${warn.message}`);
};

/**
 * Logs a general message to the console.
 * @param {string} msg - The message to log.
 */
export const cliMsg = (msg) => {
  console.log(msg);
};

/**
 * Pauses execution for a specified number of milliseconds.
 * @param {number} ms - The number of milliseconds to sleep.
 * @returns {Promise<void>} A promise that resolves after the specified delay.
 */
export const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Generates a random integer between 0 and 100.
 * @returns {number} A random integer.
 */
export const randomScalingFactor = () => {
  return Math.round(Math.random() * 100);
};

/**
 * Generates a random hexadecimal color code.
 * @returns {string} A random color code (e.g., "#a2c4e6").
 */
export const randomHexColorCode = () => {
  return "#" + Math.floor(Math.random() * 16777215).toString(16);
};

/**
 * Generates an array of four random integers between 0 and 100.
 * @returns {number[]} An array of four random integers.
 */
export const randomArray4 = () => {
  return [
    Math.round(Math.random() * 100),
    Math.round(Math.random() * 100),
    Math.round(Math.random() * 100),
    Math.round(Math.random() * 100),
  ];
};

/**
 * Scales a number from one range to another.
 * @param {number} num - The number to scale.
 * @param {number} in_min - The minimum of the input range.
 * @param {number} in_max - The maximum of the input range.
 * @param {number} out_min - The minimum of the output range.
 * @param {number} out_max - The maximum of the output range.
 * @returns {number} The scaled number.
 */
export const scale = (num, in_min, in_max, out_min, out_max) => {
  return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
};

/**
 * Checks if an object is empty.
 * @param {object} obj - The object to check.
 * @returns {boolean} True if the object is empty, false otherwise.
 */
export const isObjEmpty = (obj) => {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return true;
};

/**
 * Extracts a substring between two tags.
 * @param {string} source - The source string.
 * @param {string} startTag - The starting tag.
 * @param {string} endTag - The ending tag.
 * @returns {string} The extracted substring, or an empty string if not found.
 */
export const getTextBetween = (source, startTag, endTag) => {
  const startIndex = source.indexOf(startTag);
  if (startIndex === -1) {
    return "";
  }
  const endIndex = source.indexOf(endTag, startIndex + startTag.length);
  if (endIndex === -1) {
    return "";
  }
  return source.substring(startIndex + startTag.length, endIndex);
};

/**
 * Formats file size in human-readable format.
 * @param {number} bytes - The size in bytes.
 * @returns {string} The formatted size (e.g., "1.5 MB").
 */
export const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
};

/**
 * Formats a date in human-readable format.
 * @param {Date} date - The date to format.
 * @returns {string} The formatted date (e.g., "Jan 15, 2025").
 */
export const formatDate = (date) => {
  if (!date || !(date instanceof Date) || isNaN(date)) {
    return 'Invalid Date';
  }

  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };

  return date.toLocaleDateString('en-US', options);
};

/**
 * Formats a number with thousands separators.
 * @param {number} num - The number to format.
 * @returns {string} The formatted number (e.g., "1,234,567").
 */
export const formatNumber = (num) => {
  return num.toLocaleString('en-US');
};
