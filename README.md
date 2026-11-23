# AR WA GROUP MESSAGE FORWARD

A smart and efficient **WhatsApp Group Message Forwarding Software** for Windows.
It reads new messages from one **source group** and sends the **exact same text** to one
or many **target groups** — automatically, on a daily schedule.

**Developed by Ariful Islam**
Phone: +880 1307-432200 · Email: arifulislam4390@gmail.com

---

## What it does

- Forwards the **original text unchanged** — no prefix, no suffix, no trimming, no
  reformatting. Emoji, Bengali text, digits, spaces and line breaks stay exactly as they
  were received.
- The same message goes to **every selected target group**.
- **Text only.** Images, PDFs, videos, audio, stickers and documents are **never**
  forwarded.
- Messages you send yourself are **not** forwarded (no loops).
- Runs every day only inside a **time window** (default `09:50 – 16:28`). A message that
  arrives outside the window is not sent.
- Optional **daily limit** and **delay between groups** so WhatsApp does not flag the account.
- Password protected start-up screen.
- Forward history, counters, activity log and a **Check now** button that explains why
  something was not forwarded.

## Screens

| Main window | Password screen |
|---|---|
| ![App](app-preview.png) | ![Lock](lock-screen.png) |

## Install (for users)

1. Download `AR-WhatsApp-Forwarder-Windows.zip` from the **Releases** page and unzip it.
2. Run **`AR WhatsApp Forwarder.exe`** (no installer, no extra software needed —
   Windows 10/11 64-bit).
3. Enter the password to unlock the app.
4. Press **Connect WhatsApp** and scan the QR code with your phone
   (WhatsApp → Linked devices → Link a device).
5. Choose the **source group**, tick the **target groups**, press **Save groups**.
6. Set the schedule and press **Save settings**. Use **Send test message** to try it once.

The WhatsApp login is stored on that PC, so next time it connects automatically.
The app must stay open (and the PC on) for forwarding to work.

## Build from source

Requirements: Node.js 18+ on Windows.

```bash
npm install
npm start                 # run in development
npm run pack              # build release/AR WhatsApp Forwarder-win32-x64
```

The packaged app is produced with `@electron/packager` and the icon in `build/icon.ico`.

## How it works

`wa-engine.js` tries the `whatsapp-web.js` engine first; if WhatsApp Web's internal
modules change and that engine cannot start, it falls back to `manual-wa.js`, a Puppeteer
engine that drives `web.whatsapp.com` through the user interface:

- opens a chat by clicking its row (or by searching its name),
- types the message line by line (`Shift+Enter` between lines, `Enter` to send),
- reads new messages by walking the message bubble's text nodes, so **one line break in
  the chat becomes exactly one `\n`** — no doubled gaps.

All settings, the session and the log live in
`%APPDATA%\AR WhatsApp Forwarder\`.

## Project layout

```
main.js            Electron main process: windows, IPC, schedule, forwarding, password gate
wa-engine.js       Two-engine orchestrator
manual-wa.js       Puppeteer UI engine (send, read, group list, QR)
preload.js         Safe bridge for the app window
lock-preload.js    Safe bridge for the password window
app/index.html     App UI
app/renderer.js    App UI logic
app/lock.html      Password screen
build/icon.ico     App icon
```

## Licence

MIT — see [LICENSE](LICENSE).

© 2026 Ariful Islam · All rights reserved.
