// content.js — GForm AI AutoFill
// Runs in Google Forms page context.
// Responsibilities:
//   1. Extract form field metadata (getFormFields)
//   2. Fill form fields via DOM manipulation (fillForm)

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Set value on a React-controlled input/textarea without React ignoring the
 * change. React overrides the native value setter, so we must bypass that
 * and then dispatch the events React's synthetic system listens to.
 */
function setNativeInputValue(element, value) {
  const proto = element.tagName === 'TEXTAREA'
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  nativeSetter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Scroll to the bottom to force lazy-rendered questions to appear, then
 * scroll back to the top.
 */
async function ensureAllFieldsVisible() {
  window.scrollTo(0, document.documentElement.scrollHeight);
  await delay(500);
  window.scrollTo(0, 0);
  await delay(200);
}

// ---------------------------------------------------------------------------
// Container discovery
// ---------------------------------------------------------------------------

/**
 * Find all question containers using multiple strategies across Google Forms
 * UI versions. Returns a deduplicated list of container elements.
 *
 * Google Forms has gone through several DOM rewrites. The strategies below
 * cover the main known variants:
 *
 *  A) data-params attribute — present on question divs across all versions
 *  B) freebirdFormviewerViewItemsItemItem class — older/classic UI
 *  C) Descending from native radio/checkbox/text inputs up to their question root
 */
function findQuestionContainers() {
  const seen = new Set();
  const results = [];

  function add(el) {
    if (el && !seen.has(el)) {
      seen.add(el);
      results.push(el);
    }
  }

  // Strategy A: data-params (most universal)
  document.querySelectorAll('div[data-params]').forEach(add);

  // Strategy B: classic class name
  document.querySelectorAll('div.freebirdFormviewerViewItemsItemItem').forEach(add);

  // Strategy C: walk up from any input/textarea/radio/checkbox to find the
  // enclosing question block. We look for a div that contains BOTH a
  // question-title-like heading AND the input.
  if (results.length === 0) {
    const inputs = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], input[type="text"], ' +
      'input[type="email"], input[type="number"], textarea'
    );
    for (const input of inputs) {
      // Walk up until we find a sizeable block that looks like a question
      let el = input.parentElement;
      while (el && el !== document.body) {
        // A question block typically contains both a heading-like element and an input
        const hasHeading = el.querySelector('span[role="heading"], [aria-level]');
        if (hasHeading && el.querySelectorAll('input, textarea').length > 0) {
          add(el);
          break;
        }
        el = el.parentElement;
      }
    }
  }

  // Sort by document order
  results.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  return results;
}

// ---------------------------------------------------------------------------
// Field type detection
// ---------------------------------------------------------------------------

/**
 * Detect the field type by probing descendant elements of the container.
 * We search the whole container (not just a specific child class) so this
 * works regardless of the inner wrapping structure Google uses.
 */
function detectFieldType(container) {
  if (container.querySelector('input[type="file"]'))
    return 'file_upload';

  if (container.querySelector('div[role="listbox"]'))
    return 'dropdown';

  // Radio — ARIA custom or native
  if (container.querySelector('div[role="radio"], input[type="radio"]'))
    return 'radio';

  // Checkbox — ARIA custom or native
  if (container.querySelector('div[role="checkbox"], input[type="checkbox"]'))
    return 'checkbox';

  if (container.querySelector('textarea'))
    return 'textarea';

  if (container.querySelector('input[type="date"]'))
    return 'date';

  if (container.querySelector('input[type="time"]'))
    return 'time';

  // Google's custom date-parts (separate month/day/year number inputs)
  if (container.querySelector('.freebirdFormviewerViewItemsDateDateInputs'))
    return 'date_parts';

  // Generic text inputs
  if (container.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input'))
    return 'text';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Label extraction
// ---------------------------------------------------------------------------

function getLabel(container, index) {
  const candidates = [
    // Newer Google Forms
    'span[role="heading"]',
    '[aria-level="3"]',
    '[aria-level="2"]',
    // Older Google Forms
    '.freebirdFormviewerViewItemsItemItemTitle',
    '.exportItemTitle',
    // Generic heading fallback
    'h1, h2, h3, h4',
  ];

  for (const sel of candidates) {
    const el = container.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text) return text;
  }

  // Last resort: first text node with reasonable length
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text.length > 3 && text.length < 300) return text;
  }

  return `Field ${index}`;
}

// ---------------------------------------------------------------------------
// Options extraction (for radio, checkbox, dropdown)
// ---------------------------------------------------------------------------

function getOptions(container, type) {
  if (type === 'radio') {
    // ARIA custom radios
    const ariaRadios = container.querySelectorAll('div[role="radio"]');
    if (ariaRadios.length > 0) {
      return Array.from(ariaRadios)
        .map(el => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter(Boolean);
    }
    // Native radio inputs — get label text
    return Array.from(container.querySelectorAll('input[type="radio"]'))
      .map(r => {
        const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
        return (label?.textContent || r.value || '').trim();
      })
      .filter(Boolean);
  }

  if (type === 'checkbox') {
    const ariaCheckboxes = container.querySelectorAll('div[role="checkbox"]');
    if (ariaCheckboxes.length > 0) {
      return Array.from(ariaCheckboxes)
        .map(el => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter(Boolean);
    }
    return Array.from(container.querySelectorAll('input[type="checkbox"]'))
      .map(cb => {
        const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
        return (label?.textContent || cb.value || '').trim();
      })
      .filter(Boolean);
  }

  if (type === 'dropdown') {
    // Native select
    const nativeSelect = container.querySelector('select');
    if (nativeSelect) {
      return Array.from(nativeSelect.options)
        .map(o => o.text.trim())
        .filter(t => t && t.toLowerCase() !== 'choose' && t !== '');
    }
    // Custom ARIA options (may be empty until dropdown is opened)
    return Array.from(container.querySelectorAll('div[role="option"], li[role="option"]'))
      .map(el => (el.getAttribute('data-value') || el.textContent || '').trim())
      .filter(Boolean);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/**
 * Scan the page and return an array of FieldDescriptor objects.
 * @returns {FieldDescriptor[]}
 */
function extractFormFields() {
  const containers = findQuestionContainers();
  const fields = [];
  let index = 0;

  for (const container of containers) {
    const type = detectFieldType(container);
    if (type === 'unknown' || type === 'file_upload') continue;

    const required =
      !!container.querySelector('[aria-required="true"]') ||
      !!container.querySelector('.freebirdFormviewerViewItemsItemRequiredAsterisk') ||
      !!container.querySelector('.freebirdFormviewerViewItemsItemItemRequiredAsterisk') ||
      Array.from(container.querySelectorAll('span')).some(s => s.textContent.trim() === '*');

    // -----------------------------------------------------------------------
    // Grid question: one container holds multiple div[role="radiogroup"] rows
    // (e.g. "How satisfied were you with X?" with sub-rows per aspect).
    // Expand each row into its own field so Claude can target them individually.
    // -----------------------------------------------------------------------
    if (type === 'radio') {
      const radiogroups = Array.from(container.querySelectorAll('div[role="radiogroup"]'));
      if (radiogroups.length > 1) {
        // Derive column options from the first row's radio inputs
        const columnOptions = Array.from(radiogroups[0].querySelectorAll('input[type="radio"]'))
          .map(r => r.value)
          .filter(Boolean);

        for (const rg of radiogroups) {
          const rowLabel =
            rg.getAttribute('aria-label') ||
            rg.querySelector('span:first-child, td:first-child, th:first-child')?.textContent?.trim() ||
            `Row ${index}`;

          // Stamp the radiogroup element itself so getContainerByIndex resolves to it
          rg.setAttribute('data-gform-fill-idx', String(index));

          fields.push({
            id:              `field_${index}`,
            label:           rowLabel,
            type:            'radio',
            required,
            options:         columnOptions,
            _containerIndex: index,
          });
          index++;
        }
        continue; // skip default processing for this outer container
      }
    }

    // -----------------------------------------------------------------------
    // Normal (non-grid) field
    // -----------------------------------------------------------------------
    const label   = getLabel(container, index);
    const options = getOptions(container, type);

    container.setAttribute('data-gform-fill-idx', String(index));

    fields.push({
      id:              `field_${index}`,
      label,
      type,
      required,
      options,
      _containerIndex: index,
    });

    index++;
  }

  return fields;
}

/** Re-find a container element by the index stamped during extraction. */
function getContainerByIndex(idx) {
  return document.querySelector(`[data-gform-fill-idx="${idx}"]`) ??
         (() => {
           // Fallback: re-run container discovery and pick by index
           const all = findQuestionContainers();
           return all[idx] ?? null;
         })();
}

// ---------------------------------------------------------------------------
// Fill helpers per field type
// ---------------------------------------------------------------------------

async function fillText(container, value) {
  const input = container.querySelector(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type="radio"]):not([type="checkbox"]):not([type="file"])'
  );
  if (!input) throw new Error('No text input found');
  input.focus();
  setNativeInputValue(input, String(value));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function fillTextarea(container, value) {
  const ta = container.querySelector('textarea');
  if (!ta) throw new Error('No textarea found');
  ta.focus();
  setNativeInputValue(ta, String(value));
  ta.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function fillRadio(container, value) {
  const normalizedValue = String(value).toLowerCase().trim();

  // Try ARIA custom radio divs first
  const ariaRadios = container.querySelectorAll('div[role="radio"]');
  for (const radio of ariaRadios) {
    const label = (radio.getAttribute('aria-label') || radio.textContent || '').toLowerCase().trim();
    if (label === normalizedValue || label.includes(normalizedValue)) {
      radio.click();
      return;
    }
  }

  // Try native radio inputs
  const nativeRadios = container.querySelectorAll('input[type="radio"]');
  for (const radio of nativeRadios) {
    const labelEl = radio.closest('label') || document.querySelector(`label[for="${radio.id}"]`);
    const labelText = (labelEl?.textContent || radio.value || '').toLowerCase().trim();
    if (labelText === normalizedValue || labelText.includes(normalizedValue)) {
      // Click the label for reliable activation
      if (labelEl) {
        labelEl.click();
      } else {
        radio.click();
      }
      return;
    }
  }

  throw new Error(`No radio option matching "${value}"`);
}

async function fillCheckbox(container, value) {
  const values = Array.isArray(value)
    ? value
    : String(value).split(',').map(v => v.trim());
  const normalizedValues = values.map(v => v.toLowerCase().trim());

  // ARIA custom checkboxes
  const ariaCheckboxes = container.querySelectorAll('div[role="checkbox"]');
  if (ariaCheckboxes.length > 0) {
    for (const cb of ariaCheckboxes) {
      const label = (cb.getAttribute('aria-label') || cb.textContent || '').toLowerCase().trim();
      const shouldCheck = normalizedValues.some(v => label === v || label.includes(v));
      const isChecked = cb.getAttribute('aria-checked') === 'true';
      if (shouldCheck !== isChecked) cb.click();
    }
    return;
  }

  // Native checkboxes
  const nativeCheckboxes = container.querySelectorAll('input[type="checkbox"]');
  for (const cb of nativeCheckboxes) {
    const labelEl = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
    const labelText = (labelEl?.textContent || cb.value || '').toLowerCase().trim();
    const shouldCheck = normalizedValues.some(v => labelText === v || labelText.includes(v));
    if (shouldCheck !== cb.checked) {
      if (labelEl) labelEl.click();
      else cb.click();
    }
  }
}

async function fillDropdown(container, value) {
  const normalizedValue = String(value).toLowerCase().trim();

  // 1. Native <select>
  const nativeSelect = container.querySelector('select');
  if (nativeSelect) {
    const match = Array.from(nativeSelect.options).find(o =>
      o.text.toLowerCase().trim() === normalizedValue ||
      o.text.toLowerCase().trim().includes(normalizedValue) ||
      o.value.toLowerCase().trim() === normalizedValue
    );
    if (!match) throw new Error(`No dropdown option matching "${value}"`);
    setNativeInputValue(nativeSelect, match.value);
    nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // 2. Locate the trigger element
  const trigger =
    container.querySelector('div[role="listbox"]') ??
    container.querySelector('.freebirdFormviewerViewItemsSelectSelect') ??
    container.querySelector('[aria-haspopup="listbox"]') ??
    container.querySelector('[aria-expanded]');

  if (!trigger) throw new Error('No dropdown trigger found');

  // 3. Find the matching option element.
  //    DOM structure confirmed: div[role="option"] with data-value="Maybe" etc.
  //    data-value holds the exact display text, NOT a numeric index.
  function findOptionEl() {
    // Primary: role="option" elements anywhere in the document, matched by
    // data-value OR text content. Do NOT filter by trigger.contains() —
    // the panel may render as a child of the trigger's parent container.
    const roleOptions = Array.from(
      document.querySelectorAll('div[role="option"], li[role="option"]')
    );
    const byRole = roleOptions.find(el => {
      const dataVal = (el.getAttribute('data-value') || '').toLowerCase().trim();
      const textVal = el.textContent.trim().toLowerCase();
      return dataVal === normalizedValue || textVal === normalizedValue;
    });
    if (byRole) return byRole;

    // Fallback: any visible element whose trimmed text exactly matches.
    return Array.from(document.querySelectorAll('*'))
      .filter(el => {
        if (el === trigger) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        return el.textContent.trim().toLowerCase() === normalizedValue;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      })[0] ?? null;
  }

  // 4. Open the dropdown, then poll every 200ms (up to 3s) until the option
  //    element appears in the DOM. Clicks as soon as it's ready.
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));

  let optionEl = null;
  const pollInterval = 200;
  const maxWait = 3000;
  let waited = 0;
  while (waited < maxWait) {
    await delay(pollInterval);
    waited += pollInterval;
    optionEl = findOptionEl();
    if (optionEl) break;
  }
  if (optionEl) {
    optionEl.click();
    return;
  }

  // Close on failure
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  throw new Error(`No dropdown option matching "${value}"`);
}

function parseDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return { year: +year, month: +month, day: +day };
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
    const [month, day, year] = value.split('/');
    return { year: +year, month: +month, day: +day };
  }
  const parsed = new Date(value);
  if (!isNaN(parsed)) {
    return { year: parsed.getFullYear(), month: parsed.getMonth() + 1, day: parsed.getDate() };
  }
  throw new Error(`Cannot parse date: "${value}"`);
}

async function fillDate(container, value) {
  const dateInput = container.querySelector('input[type="date"]');
  if (dateInput) {
    const d = parseDate(String(value));
    const formatted = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    setNativeInputValue(dateInput, formatted);
    return;
  }
  const datePartsContainer = container.querySelector('.freebirdFormviewerViewItemsDateDateInputs');
  if (datePartsContainer) {
    const d = parseDate(String(value));
    const inputs = datePartsContainer.querySelectorAll('input[type="number"]');
    if (inputs[0]) setNativeInputValue(inputs[0], String(d.month));
    if (inputs[1]) setNativeInputValue(inputs[1], String(d.day));
    if (inputs[2]) setNativeInputValue(inputs[2], String(d.year));
    return;
  }
  throw new Error('No date input found');
}

async function fillTime(container, value) {
  const timeInput = container.querySelector('input[type="time"]');
  if (timeInput) {
    setNativeInputValue(timeInput, String(value));
    return;
  }
  const inputs = container.querySelectorAll('input[type="number"]');
  const parts = String(value).split(':');
  if (parts.length >= 2 && inputs.length >= 2) {
    setNativeInputValue(inputs[0], parts[0]);
    setNativeInputValue(inputs[1], parts[1]);
    return;
  }
  throw new Error('No time input found');
}

// ---------------------------------------------------------------------------
// Fill single field dispatcher
// ---------------------------------------------------------------------------

async function fillSingleField(container, type, value) {
  switch (type) {
    case 'text':
    case 'number':
      await fillText(container, value);
      break;
    case 'textarea':
      await fillTextarea(container, value);
      break;
    case 'radio':
      await fillRadio(container, value);
      break;
    case 'checkbox':
      await fillCheckbox(container, value);
      break;
    case 'dropdown':
      await fillDropdown(container, value);
      break;
    case 'date':
    case 'date_parts':
      await fillDate(container, value);
      break;
    case 'time':
      await fillTime(container, value);
      break;
    default:
      throw new Error(`Unsupported field type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Fill orchestration
// ---------------------------------------------------------------------------

async function fillFormFields(mapping) {
  const results = { filled: 0, skipped: 0, errors: [] };

  // Re-discover containers in document order (stamps fresh _gformFillIdx)
  const fields = extractFormFields();

  for (const field of fields) {
    const value = mapping[field.id];
    if (value === null || value === undefined || value === '') {
      results.skipped++;
      continue;
    }

    try {
      const container = getContainerByIndex(field._containerIndex);
      if (!container) throw new Error('Container not found in DOM');
      await fillSingleField(container, field.type, value);
      results.filled++;
      await delay(60);
    } catch (err) {
      results.errors.push({ field: field.label, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ alive: true });
    return false;
  }

  if (message.action === 'getFormFields') {
    ensureAllFieldsVisible().then(() => {
      const fields = extractFormFields();
      sendResponse({ success: true, fields });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'fillForm') {
    fillFormFields(message.data)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});
