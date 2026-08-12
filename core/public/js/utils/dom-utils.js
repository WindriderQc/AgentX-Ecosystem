/**
 * @file DOM manipulation utility functions.
 */

/**
 * Displays an array of items in a specified DOM element, creating a list.
 * This function clears the container element before appending the new list.
 * It uses a DocumentFragment for efficient DOM updates.
 *
 * @param {Array<any>} arr - The array of items to display.
 * @param {string} domId - The ID of the DOM element to populate.
 */
export const showArrayOnDOM = (arr, domId) => {
  const container = document.getElementById(domId);
  if (!container) {
    console.error(`DOM element with ID "${domId}" not found.`);
    return;
  }

  // Clear previous content
  container.innerHTML = '';

  // Use a DocumentFragment for performance
  const fragment = document.createDocumentFragment();

  arr.forEach(item => {
    const li = document.createElement('li');
    li.textContent = JSON.stringify(item, null, 2); // Pretty print JSON
    fragment.appendChild(li);
  });

  container.appendChild(fragment);
};

/**
 * Gets the selected option element from a <select> element.
 *
 * @param {HTMLSelectElement} selectElement - The <select> DOM element.
 * @returns {HTMLOptionElement | null} The selected option element, or null if nothing is selected.
 */
export const getSelectedOption = (selectElement) => {
  if (selectElement && selectElement.selectedIndex !== -1) {
    return selectElement.options[selectElement.selectedIndex];
  }
  return null;
};

/**
 * Populates a form with data from an object.
 *
 * @param {string} formId - The ID of the form to populate.
 * @param {object} data - The data object, where keys match form field names.
 */
export const fillForm = (formId, data) => {
  const form = document.getElementById(formId);
  if (!form) {
    console.error(`Form with ID "${formId}" not found.`);
    return;
  }

  const { elements } = form;

  for (const [key, value] of Object.entries(data)) {
    const field = elements.namedItem(key);
    if (field) {
      field.value = value;
    }
  }
};

/**
 * Populates a <select> element with options from a list.
 *
 * @param {HTMLSelectElement} selectElement - The <select> DOM element to populate.
 * @param {Array<object>} valueList - An array of objects to create options from. Each object must have an 'id' property for the option text.
 * @param {string} [selectedValue=""] - The 'id' of the item that should be selected by default.
 */
export const setOptionsOnSelect = (selectElement, valueList, selectedValue = "") => {
  if (!selectElement) {
    console.error("The provided select element is invalid.");
    return;
  }

  // Clear existing options
  selectElement.innerHTML = '';

  if (!Array.isArray(valueList) || valueList.length === 0) {
    console.warn('The provided value list is empty or invalid.');
    return;
  }

  let selectedIndex = 0;

  valueList.forEach((item, index) => {
    // Assuming the text is item.id and value is the index, as in the original function.
    // This could be made more flexible if needed.
    const option = new Option(item.id, index);
    selectElement.add(option);
    if (item.id === selectedValue) {
      selectedIndex = index;
    }
  });

  if (selectElement.options.length > 0) {
    selectElement.selectedIndex = selectedIndex;
  }
};