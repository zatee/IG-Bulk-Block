# IG Bulk Block - Mass block Instagram users without app

A browser console script that bulk-blocks Instagram accounts from your official Instagram data export (`followers_*.json` / `following.json`) — directly in Chrome, using your logged-in session. No extension, no installation, no password sharing.

## Features

- Reads the official Instagram JSON export (old and new format: username in `value`, `title` or `href`)
- Resolves user IDs with three fallback methods and automatically sticks to the one that works
- Randomized delays between blocks plus batch pauses to reduce the risk of action blocks
- Per-run limit (default: 150 blocks) to spread large lists over several days
- Stops immediately on rate limits / action blocks
- Saves progress in `localStorage` — re-running the script resumes where it left off
- Small on-page panel with file picker, start/stop buttons and a live log

## Requirements

- Desktop browser (tested with Chrome on macOS)
- Logged in to [instagram.com](https://www.instagram.com) with the account that should do the blocking
- A JSON export of your Instagram data

## 1. Get your Instagram data export

1. In Instagram, open **Accounts Center → Your information and permissions → Export your information**.
2. Create an export for your profile and select **Followers and following** (that's all you need).
3. Choose **JSON** as the format.
4. Once the export is ready, download and unzip it. The files are located in `connections/followers_and_following/`.

## 2. Run the script

1. Open [instagram.com](https://www.instagram.com) in Chrome and make sure you are logged in.
2. Open the DevTools console: `Cmd + Option + J` (macOS) or `Ctrl + Shift + J` (Windows/Linux).
3. Paste the contents of [`ig-bulk-block.js`](ig-bulk-block.js) and press Enter.
   Chrome may ask you to type `allow pasting` first.
4. A panel appears in the bottom right corner. Choose your JSON file (e.g. `followers_1.json` or `following.json`).
5. Click **Start**.

Keep the tab in the foreground (or in its own window) — Chrome throttles timers in background tabs. On macOS, `caffeinate -d` in a terminal keeps your Mac from sleeping.

## 3. Continue the next day

Once the per-run limit is reached, the script stops. The next day, reload instagram.com, paste the script again, select the same JSON file and click **Start**. Accounts that are already blocked or skipped are ignored automatically.

## Configuration

Edit the `CONFIG` object at the top of the script:

| Option | Default | Description |
|---|---|---|
| `delayMinSec` | `25` | Minimum delay between two blocks (seconds) |
| `delayMaxSec` | `45` | Maximum delay between two blocks (seconds) |
| `batchSize` | `25` | Number of blocks before a longer pause |
| `batchPauseMin` | `15` | Length of that pause (minutes) |
| `maxPerRun` | `150` | Maximum number of blocks per run |
| `maxConsecutiveErrors` | `3` | Stop after this many errors in a row |

Instagram is more sensitive to blocks than to follows. Making the script faster increases the risk of temporary action blocks.

## Progress & reset

Progress is stored in your browser under the key `igBulkBlock_v2`:

- `done` — blocked (or already blocked) accounts
- `skipped` — accounts whose profile no longer exists
- `failed` — accounts that failed; these are retried on the next run

To start from scratch, run this in the console on instagram.com:

```js
localStorage.removeItem("igBulkBlock_v2")
```

## How it works

1. The JSON export is parsed and all usernames are collected (deduplicated).
2. For each username, the user ID is resolved via, in order:
   - `/api/v1/web/search/topsearch/` (exact username match)
   - the profile page HTML
   - `/api/v1/users/web_profile_info/`
3. The account is blocked via the web friendship endpoint (with fallbacks).
4. Requests use your existing session cookies and CSRF token — the script never sees or stores your password.

## Troubleshooting

| Log message | Meaning / what to do |
|---|---|
| `⛔ Rate limit / action block` | Instagram is throttling you. Wait 24 hours, then run again. |
| `Could not resolve ID (...)` | All lookup methods failed. The status codes in brackets show which method returned what. Instagram may have changed an internal endpoint. |
| `Block failed: ...` | The block request was rejected. The log shows the endpoint and HTTP status. |
| `No csrftoken found` | You are not logged in, or the script was run on a different domain. |
| `profile no longer exists` | The account was deleted or renamed; it is skipped. |

## Things to know

- Blocking an account also removes the follow relationship in both directions, and the blocked account can no longer find your profile.
- If you run the script with `following.json`, you will block (and thereby unfollow) accounts you follow.

## Disclaimer

This script uses undocumented internal Instagram web endpoints, which may change at any time without notice. Automated actions may violate Instagram's Terms of Use and can lead to temporary restrictions or other measures against your account. Use at your own risk. This project is not affiliated with, endorsed by, or connected to Instagram or Meta.
