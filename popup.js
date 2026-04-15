// popup.js — GForm AI AutoFill
// Orchestrates: init check → field detection → Claude API call → form fill

'use strict';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const fieldCountEl    = document.getElementById('fieldCount');
const notFormAlert    = document.getElementById('notFormAlert');
const noApiKeyAlert   = document.getElementById('noApiKeyAlert');
const fillPanel       = document.getElementById('fillPanel');
const promptInput     = document.getElementById('promptInput');
const fillBtn         = document.getElementById('fillBtn');
const btnText         = fillBtn.querySelector('.btn-text');
const btnSpinner      = fillBtn.querySelector('.spinner');
const statusArea      = document.getElementById('statusArea');
const resultsArea     = document.getElementById('resultsArea');
const filledCount     = document.getElementById('filledCount');
const skippedCount    = document.getElementById('skippedCount');
const errorsRow       = document.getElementById('errorsRow');
const errorsCount     = document.getElementById('errorsCount');
const errorList       = document.getElementById('errorList');
const settingsPanel   = document.getElementById('settingsPanel');
const apiKeyInput     = document.getElementById('apiKeyInput');
const saveKeyBtn      = document.getElementById('saveKeyBtn');
const keyStatus       = document.getElementById('keyStatus');
const toggleKeyBtn    = document.getElementById('toggleKeyVisibility');
const eyeIcon         = document.getElementById('eyeIcon');
const eyeOffIcon      = document.getElementById('eyeOffIcon');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentTab    = null;
let currentFields = [];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

function sendMessageToTab(tabId, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Content script timed out — try refreshing the form tab.'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, response => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0] ?? null);
    });
  });
}

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------

function setStatus(text, type /* 'loading' | 'success' | 'error' */) {
  statusArea.className = `status ${type}`;
  statusArea.innerHTML = type === 'loading'
    ? `<span class="status-spinner" aria-hidden="true"></span>${escapeHtml(text)}`
    : escapeHtml(text);
  show(statusArea);
}

function clearStatus() {
  hide(statusArea);
  statusArea.className = 'status hidden';
  statusArea.innerHTML = '';
}

function setBtnLoading(loading) {
  fillBtn.disabled = loading;
  if (loading) {
    hide(document.querySelector('.btn-text'));
    show(btnSpinner);
  } else {
    show(document.querySelector('.btn-text'));
    hide(btnSpinner);
  }
}

function updateFieldCount(count) {
  fieldCountEl.textContent = `${count} field${count !== 1 ? 's' : ''} detected`;
  fieldCountEl.classList.toggle('has-fields', count > 0);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showResults(result) {
  filledCount.textContent  = result.filled  ?? 0;
  skippedCount.textContent = result.skipped ?? 0;

  const errors = result.errors ?? [];
  errorsCount.textContent = errors.length;

  if (errors.length > 0) {
    show(errorsRow);
    errorList.innerHTML = errors
      .map(e => `<li><strong>${escapeHtml(e.field)}:</strong> ${escapeHtml(e.error)}</li>`)
      .join('');
    show(errorList);
  } else {
    hide(errorsRow);
    hide(errorList);
  }

  show(resultsArea);
}

function hideResults() {
  hide(resultsArea);
  hide(errorsRow);
  hide(errorList);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function initialize() {
  // Reset UI
  hide(notFormAlert);
  hide(noApiKeyAlert);
  clearStatus();
  hideResults();
  fillBtn.disabled = true;
  fieldCountEl.textContent = 'Detecting…';
  fieldCountEl.classList.remove('has-fields');
  currentFields = [];
  currentTab    = null;

  // 1. Check tab
  const tab = await getActiveTab();
  if (!tab?.url?.includes('docs.google.com/forms')) {
    show(notFormAlert);
    fieldCountEl.textContent = 'Not a form';
    return;
  }
  currentTab = tab;

  // 2. Check API key
  const { anthropic_api_key } = await chrome.storage.local.get('anthropic_api_key');
  if (!anthropic_api_key) {
    show(noApiKeyAlert);
    settingsPanel.open = true;
    fieldCountEl.textContent = 'No API key';
    return;
  }

  // 3. Check if content script is alive; inject if not
  let contentAlive = false;
  try {
    const pong = await sendMessageToTab(tab.id, { action: 'ping' }, 2000);
    contentAlive = pong?.alive === true;
  } catch (_) {
    // not yet injected — that's fine
  }

  if (!contentAlive) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      // Brief wait for script to initialize
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      setStatus(`Cannot inject into this page: ${err.message}`, 'error');
      fieldCountEl.textContent = 'Injection failed';
      return;
    }
  }

  // 4. Get form fields
  setStatus('Scanning form fields…', 'loading');
  let fields = [];
  try {
    const response = await sendMessageToTab(tab.id, { action: 'getFormFields' });
    if (!response?.success) throw new Error(response?.error ?? 'Unknown error');
    fields = response.fields ?? [];
  } catch (err) {
    setStatus(`Could not read form fields: ${err.message}`, 'error');
    fieldCountEl.textContent = 'Scan failed';
    return;
  }

  if (fields.length === 0) {
    setStatus('No fillable fields detected. Try waiting for the form to fully load, then reopen this popup.', 'error');
    fieldCountEl.textContent = '0 fields';
    return;
  }

  clearStatus();
  currentFields = fields;
  updateFieldCount(fields.length);
  fillBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callClaudeAPI(apiKey, userPrompt, fields) {
  // Build a compact field manifest — omit containerSelector (wastes tokens)
  const fieldManifest = fields.map(f => ({
    id:       f.id,
    label:    f.label,
    type:     f.type,
    required: f.required,
    ...(f.options?.length > 0 ? { options: f.options } : {}),
  }));

  const systemPrompt = `You are a form-filling assistant. Given form field definitions and a user instruction, call the fill_form tool with values for those fields.

Rules:
- For radio/dropdown fields, the value MUST be one of the listed options (exact match).
- For checkbox fields, return an array of option strings to check.
- For date fields, return YYYY-MM-DD format.
- For time fields, return HH:MM in 24-hour format.
- If the user did not specify a value for a field, omit that field from your response.
- If a required field has no clear match in the prompt, make a reasonable inference.`;

  const userMessage = `Form fields:\n${JSON.stringify(fieldManifest, null, 2)}\n\nUser instruction: ${userPrompt}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     systemPrompt,
      tools: [
        {
          name:        'fill_form',
          description: 'Fill the Google Form by specifying values for the detected fields.',
          input_schema: {
            type:       'object',
            properties: {
              field_values: {
                type:                 'object',
                description:          'Map of field IDs (e.g. "field_0") to their fill values.',
                additionalProperties: { type: ['string', 'array'] },
              },
            },
            required: ['field_values'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'fill_form' },
      messages: [
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    let errMsg = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody?.error?.message) errMsg = errBody.error.message;
      if (response.status === 401) errMsg = 'Invalid API key. Please check your Anthropic API key in Settings.';
      if (response.status === 429) errMsg = 'Rate limited. Please wait a moment and try again.';
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await response.json();

  // Extract the tool call input
  const toolUse = data.content?.find(b => b.type === 'tool_use' && b.name === 'fill_form');
  if (!toolUse?.input?.field_values) {
    throw new Error('Claude did not return a valid field mapping. Try rephrasing your prompt.');
  }

  return toolUse.input.field_values;
}

// ---------------------------------------------------------------------------
// Fill button handler
// ---------------------------------------------------------------------------

fillBtn.addEventListener('click', async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus('Please enter a prompt describing how to fill the form.', 'error');
    return;
  }

  if (!currentTab || currentFields.length === 0) {
    setStatus('Extension not ready. Please close and reopen this popup.', 'error');
    return;
  }

  setBtnLoading(true);
  clearStatus();
  hideResults();

  // 1. Call Claude API
  setStatus('Asking Claude…', 'loading');
  let { anthropic_api_key } = await chrome.storage.local.get('anthropic_api_key');

  let mapping;
  try {
    mapping = await callClaudeAPI(anthropic_api_key, prompt, currentFields);
  } catch (err) {
    setStatus(err.message, 'error');
    setBtnLoading(false);
    return;
  }

  // 2. Send fill instructions to content script
  setStatus('Filling form…', 'loading');
  let result;
  try {
    const response = await sendMessageToTab(currentTab.id, {
      action: 'fillForm',
      data:   mapping,
    });
    if (!response?.success) throw new Error(response?.error ?? 'Fill failed');
    result = response;
  } catch (err) {
    setStatus(err.message, 'error');
    setBtnLoading(false);
    return;
  }

  // 3. Show results
  setBtnLoading(false);
  const hasErrors = (result.errors?.length ?? 0) > 0;
  setStatus(
    hasErrors
      ? `Filled ${result.filled} field(s) with ${result.errors.length} error(s).`
      : `Successfully filled ${result.filled} field(s)!`,
    hasErrors ? 'error' : 'success'
  );
  showResults(result);
});

// ---------------------------------------------------------------------------
// Settings: save API key
// ---------------------------------------------------------------------------

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = 'Please enter a key.';
    keyStatus.className   = 'key-status error';
    return;
  }
  if (!key.startsWith('sk-ant-')) {
    keyStatus.textContent = 'Invalid format — should start with sk-ant-';
    keyStatus.className   = 'key-status error';
    return;
  }

  await chrome.storage.local.set({ anthropic_api_key: key });
  apiKeyInput.value     = '';
  keyStatus.textContent = `Saved (...${key.slice(-4)})`;
  keyStatus.className   = 'key-status success';

  // Re-initialize with the new key
  await initialize();
});

// ---------------------------------------------------------------------------
// Settings: show/hide API key
// ---------------------------------------------------------------------------

toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  eyeIcon.classList.toggle('hidden', isPassword);
  eyeOffIcon.classList.toggle('hidden', !isPassword);
});

// ---------------------------------------------------------------------------
// Settings: load saved key status on open
// ---------------------------------------------------------------------------

async function loadKeyStatus() {
  const { anthropic_api_key } = await chrome.storage.local.get('anthropic_api_key');
  if (anthropic_api_key) {
    keyStatus.textContent = `Saved (...${anthropic_api_key.slice(-4)})`;
    keyStatus.className   = 'key-status success';
  } else {
    keyStatus.textContent = '';
    keyStatus.className   = 'key-status';
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    initialize(),
    loadKeyStatus(),
  ]);
});
