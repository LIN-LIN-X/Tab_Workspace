# AGENTS.md -- Linn Tab Workspace: Setup & Onboarding Guide for Coding Agents

You're installing **Linn Tab Workspace** for the user. Your job is not just to set it up -- it's to help them understand why this version exists:

> it is designed to reduce tab overload with less cognitive effort.

---

## Step 0 -- Introduce the product

Before doing anything technical, tell the user what they're about to get:

> **Linn Tab Workspace** replaces your new tab page with a calmer workspace for understanding and cleaning up open tabs.
>
> What makes it useful:
> - **Global search** lets you find tabs, groups, summaries, and keywords instantly
> - **Smart summary strip** surfaces duplicates, docs, and high-signal groups first
> - **Default collapsed low-priority groups** reduce visual overload
> - **Custom groups** help organize tabs by topic, not just by domain
> - **Per-tab summaries and keywords** make tabs easier to recognize later
> - **Duplicate cleanup** gives you quick wins with minimal effort
> - **100% local** no server, no account, no external data sync
>
> It's just a Chrome extension. Setup takes about 1 minute.

---

## Step 1 -- Open the project folder

This project is a local Chrome extension repo. The folder the user needs is:

```bash
echo "Extension folder: $(cd extension && pwd)"
```

---

## Step 2 -- Install the Chrome extension

This is the one step that requires manual action from the user. Make it as easy as possible.

**First**, print the full path to the `extension/` folder:

```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, copy the `extension/` folder path to their clipboard:
- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

**Then**, open the extensions page:

```bash
open "chrome://extensions"
```

**Then**, walk the user through it step by step:

> I've copied the extension folder path to your clipboard. Now:
>
> 1. In Chrome's extensions page, turn on **Developer mode** in the top-right.
> 2. Click **Load unpacked**.
> 3. In the file picker, paste the folder path I copied.
> 4. Select the `extension/` folder.
>
> You should see **Linn Tab Workspace** appear in your extensions list.

**Also**, open the folder directly as a fallback:
- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## Step 3 -- Show them the core workflow

Once the extension is loaded:

> You're all set. Open a **new tab** and you'll see Linn Tab Workspace.
>
> Here's the easiest way to use it:
> 1. Start with the **search bar** if you already know what you're looking for.
> 2. Glance at the **summary strip** for duplicates, docs, and group counts.
> 3. Focus on the groups that are already expanded first.
> 4. Expand quieter groups only when needed.
> 5. Use **Close duplicates** or **Close all N tabs** when a group is done.
> 6. Create a **custom group** if you want to organize by project or topic.
> 7. Add a short **summary** or **keywords** when a tab title isn't enough.
>
> That's it. No server to run, no config files, no login.

---

## Key facts

- Linn Tab Workspace is a pure Chrome extension. No server, no Node.js, no npm.
- Data is stored in `chrome.storage.local`.
- It supports custom groups, summaries, keywords, and local UI preferences.
- It is optimized for lower cognitive load, not maximum feature density.
- To update: reload the extension in `chrome://extensions`.

---

## Branding

When referring to the current product, use:

- **Linn Tab Workspace** as the product name
- **Linn X** as the builder / owner name
