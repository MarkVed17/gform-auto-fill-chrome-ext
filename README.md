# GForm AI AutoFill

A Chrome Extension that auto-fills Google Forms using natural language prompts powered by the Claude API.

## Demo

Describe how you want the form filled in plain English — the extension detects all form fields, sends them to Claude, and fills everything in automatically.

> _"I am very satisfied with the event. I'd definitely recommend it. Fill all logistics fields with 5."_

## Features

- **Natural language input** — describe what to fill, not which field to click
- **All field types supported** — text, textarea, multiple choice, checkboxes, dropdowns, date, time, and grid/matrix questions
- **Claude-powered mapping** — uses `claude-sonnet-4-6` with forced tool use for structured, reliable output
- **Secure key storage** — your Anthropic API key is stored locally in `chrome.storage.local`, never sent anywhere except `api.anthropic.com`

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon will appear in your toolbar

## Setup

1. Click the extension icon on any Google Form tab
2. Expand **Settings** and paste your [Anthropic API key](https://console.anthropic.com/api-keys)
3. Click **Save Key**

## Usage

1. Open a Google Form in Chrome
2. Click the **GForm AutoFill** extension icon
3. Type a prompt describing how to fill the form
4. Click **Fill Form with AI**

The extension will:
- Scan all form fields and send them to Claude
- Get back a field→value mapping
- Fill each field using DOM events that Google Forms recognises

## Supported Field Types

| Type | Notes |
|---|---|
| Short answer / Paragraph | Text and textarea inputs |
| Multiple choice | Single-select radio buttons |
| Checkboxes | Multi-select, pass comma-separated values |
| Dropdown | Custom Google Forms select widget |
| Linear scale / Rating | Numeric radio groups |
| Grid / Matrix | Each row treated as an individual field |
| Date | Accepts `YYYY-MM-DD`, `MM/DD/YYYY`, or natural language |
| Time | Accepts `HH:MM` 24-hour format |

## Tech Stack

- **Manifest V3** Chrome Extension (no build step, plain JS/HTML/CSS)
- **Claude API** — `claude-sonnet-4-6` via direct `fetch` from the popup
- **Tool use** — Claude is forced to call a `fill_form` tool, guaranteeing structured JSON output with no parsing heuristics

## Project Structure

```
├── manifest.json   # MV3 manifest — permissions, content script config
├── content.js      # Injected into Google Forms — field detection + DOM fill
├── popup.html      # Extension popup UI
├── popup.css       # Popup styles
├── popup.js        # Popup logic — init, Claude API call, fill orchestration
└── icons/          # Extension icons (16, 48, 128px)
```
