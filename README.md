# Tab Workspace

**A calmer new tab for people who always have too many tabs open.**
**Linn Tab Workspace is a Chrome extension that turns your new tab page into a calmer workspace for understanding and
  cleaning up open tabs.**

Linn Tab Workspace is a Chrome extension that replaces your new tab page with a lightweight tab workspace designed to reduce cognitive load.

Instead of making you manually manage everything, it helps you:
- see the highest-signal groups first
- search all open tabs instantly
- understand each tab with a short summary
- move tabs into your own custom groups
- clean up duplicates quickly

No server. No account. No external API calls. Just a Chrome extension.

---

## What it is optimized for

This version is designed around one goal:

> **help you decide faster, with less mental effort**

That means the extension tries to feel closer to a simple search-and-action workflow than a complicated dashboard.

---

## Current features

- **Global search** across open tabs, groups, summaries, and keywords
- **Smart summary strip** at the top to surface tab count, duplicates, docs, and quieter groups
- **Low-priority groups collapse by default** so the page feels lighter on first glance
- **Custom groups** you can create yourself and assign tabs into
- **Per-tab summaries** with automatic defaults and manual editing
- **Per-tab keywords** for faster recognition later
- **Duplicate detection** with one-click cleanup
- **Jump to tab instantly** across Chrome windows
- **Color customization** for background, module color, and accent color
- **100% local** with data stored in `chrome.storage.local`
- **Pure Chrome extension** with no server, no Node.js, and no npm setup

---

## Manual setup

### 1. Open Chrome extensions

Go to:

```text
chrome://extensions
```

### 2. Enable Developer mode

Use the toggle in the top-right corner.

### 3. Load the extension

Click **Load unpacked** and select:

```text
extension/
```

inside this repo.

### 4. Open a new tab

You should see **Linn Tab Workspace**.

---

## How to use it

### The fastest workflow

1. Open a new tab
2. Glance at the **summary strip**
3. Use the **search bar** if you already know what you want
4. Focus on the expanded high-signal groups first
5. Expand quieter groups only if needed

### Organizing tabs

- Create a custom group from the **Customize** panel
- Or assign a tab directly using the tab-level group selector
- Edit a tab's summary or keywords if you want it to be easier to recognize later

### Cleaning up

- Use **Close duplicates** on groups that contain repeated tabs
- Use **Close all N tabs** when a whole group is done
- Click a tab title to jump straight to it

---

## Design principles

Linn Tab Workspace is intentionally opinionated:

- **less scanning, more conclusions**
- **less configuration, more sensible defaults**
- **less visual noise, more useful actions**

The goal is not to expose every possible tab-management feature.
The goal is to help you understand and act quickly.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | `chrome.storage.local` |
| Sound | Web Audio API |
| UI | HTML + CSS + vanilla JavaScript |
| Animations | CSS transitions + JS confetti particles |

---

## Local data

Everything stays on your machine.

Stored locally:
- UI preferences
- custom groups
- tab-to-group assignments
- keywords
- summaries

No external backend is required.

---

## Updating

Reload the extension in:

```text
chrome://extensions
```

after making changes.

---

## License

MIT

---

Built and customized by **Linn X**.
