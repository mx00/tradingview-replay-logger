# TradingView Replay → TraderNote Auto Logger

Automatically log TradingView Replay trades into TraderNote with entry/exit screenshots.

This logger watches TradingView Replay position events through Chrome DevTools Protocol (CDP), captures screenshots when a position opens/closes, and writes the trade into TraderNote using the correct daily grouping model.

---

## What it does

- Detects TradingView Replay position opens and closes automatically
- Captures an entry screenshot
- Captures an exit screenshot
- Saves screenshots locally in `./screenshots`
- Creates or updates the correct TraderNote daily trade object
- Supports multiple trades on the same trading day
- Recalculates TraderNote `blotter` and `pAndL`
- Uploads screenshots and links them to the correct TraderNote trade
- Avoids duplicate day objects that can break TraderNote Dashboard/Daily views

---

## Project files

Your project should contain:

```text
tv-replay-logger/
├── package.json
├── package-lock.json
├── .env.example
├── .env                 # local only; do not commit
├── README.md
├── tab-probe.mjs
├── trade-monitor.js
├── tradenote.js
└── screenshots/         # generated automatically; do not commit
```

Main files:

- `trade-monitor.js` — monitors TradingView Replay position changes and captures screenshots.
- `tab-probe.mjs` — connects to TradingView through CDP and extracts position/quote/replay data.
- `tradenote.js` — creates/updates TraderNote daily trade objects and uploads screenshots.
- `.env.example` — safe config template for GitHub.
- `.env` — your private local config with real credentials.

The project uses Node ESM and depends on `ws`, as defined in `package.json`.

---

## Prerequisites

### 1. macOS, Linux, or Windows

This project was tested on macOS with TradingView Desktop.

The screenshot compression step uses macOS `sips`. On non-macOS systems, the script may still work, but screenshot compression may need to be changed.

### 2. Node.js

Install Node.js 20 or newer.

Check:

```bash
node -v
npm -v
```

### 3. TradingView Desktop

Install TradingView Desktop.

The logger needs TradingView running with Chrome DevTools Protocol enabled.

### 4. TraderNote

You need a working TraderNote instance.

Example:

```text
https://tradernote.your-domain.com
```

You also need:

- TraderNote Parse App ID
- TraderNote Parse Master Key
- TraderNote User Object ID

### 5. tradingview-mcp

This project works alongside the TradingView MCP ecosystem.

GitHub:

https://github.com/tradesdontlie/tradingview-mcp

The logger itself uses CDP directly through `tab-probe.mjs`, but TradingView MCP is useful for health checks, screenshots, and Claude Code integration.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/tv-replay-logger.git
cd tv-replay-logger
```

### 2. Install dependencies

```bash
npm install
```

This installs the required WebSocket dependency.

### 3. Create your private environment file

```bash
cp .env.example .env
```

Open it:

```bash
nano .env
```

Fill in your real values.


---

## Start TradingView in debug mode

The logger connects to TradingView using Chrome DevTools Protocol.

On macOS, start TradingView Desktop like this:

```bash
open -na "TradingView" --args --remote-debugging-port=9222
```

Verify the debug port:

```bash
curl http://localhost:9222/json/version
```

You should see JSON similar to:

```json
{
  "Browser": "Chrome/...",
  "Protocol-Version": "1.3",
  "webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/..."
}
```

If this command fails, TradingView is not exposing the debug port.

---

## Start TradingView Replay

1. Open TradingView Desktop.
2. Open the chart you want to replay.
3. Start Bar Replay.
4. Make sure the replay trading controls are visible.
5. Keep the chart tab open.

---

## Run the logger

From the project folder:

```bash
node trade-monitor.js
```

Or:

```bash
npm run monitor
```

The script will list available TradingView chart tabs:

```text
Found 1 TradingView chart tabs:

[01] BINANCE:SOLUSDT.P 🔄 REPLAY ← active

Which tab to track? (1-1):
```

Enter the tab number.

You should then see:

```text
✅ Tracking: BINANCE:SOLUSDT.P
✅ CDP Network capture active
✅ Replay active
Just click Buy/Sell in TradingView — trades log automatically.
Watching…
```

---

## Normal usage

### Open a replay position

Click Buy or Sell in TradingView Replay.

The script should detect the entry:

```text
🟢 POSITION OPENED
Charts: ./screenshots/entry-...
Waiting for close…
```

### Close the replay position

Close the position in TradingView Replay.

The script should detect the exit:

```text
🔴 POSITION CLOSED
Logging replay trade to TraderNote
TraderNote day object created/updated
entry screenshot uploaded
exit screenshot uploaded
TRADE LOGGED TO TRADERNOTE
```

Then open TraderNote and check:

```text
Daily → selected day → Trades / Screenshots
```

---

## Screenshots

Screenshots are saved locally in:

```text
./screenshots
```

Example:

```text
screenshots/entry-2026-05-14T04-54-08-710Z.png
screenshots/exit-2026-05-14T04-54-54-373Z.png
```

The script compresses screenshots before uploading to TraderNote.

---

## How TraderNote grouping works

TraderNote expects:

```text
One Parse `trades` object per trading day.
```

Inside that daily object:

```text
executions[] = all executions for the day
trades[]     = all completed trades for the day
blotter{}    = per-symbol daily totals
pAndL{}      = full-day totals
```

Correct timestamp model:

```text
dateUnix / td = trading-day bucket
execTime      = exact execution timestamp
entryTime     = exact entry timestamp
exitTime      = exact exit timestamp
```

This project follows that model.

For the first trade of a day:

```text
POST new daily object
```

For later trades on the same day:

```text
GET existing daily object
append executions[]
append trades[]
recalculate blotter
recalculate pAndL
PUT updated object
```

This avoids creating duplicate daily objects.

---

## Symbol handling

TradingView symbols may contain characters that Parse/MongoDB does not allow in nested object keys.

Example:

```text
BINANCE:SOLUSDT.P
```

The logger converts it to:

```text
SOLUSDT_P
```

This avoids errors like:

```text
Nested keys should not contain the '$' or '.' characters
```

---

## Duplicate trade handling

Trade IDs are generated from:

```text
entry timestamp + symbol + type + side
```

Example:

```text
t1778734448_SOLUSDT_P_stock_B
```

If the same trade ID already exists in the daily object, the script skips it.

---

## Optional: skip tab picker

After the first run, the script prints:

```text
TV_TARGET_ID=...
```

Add that to `.env`:

```env
TV_TARGET_ID=YOUR_TARGET_ID
```

Next time, the script will track that chart automatically.

---

## Troubleshooting

### `curl http://localhost:9222/json/version` fails

TradingView is not running in debug mode.

Restart it:

```bash
open -na "TradingView" --args --remote-debugging-port=9222
```

### No chart tabs found

Check:

```bash
curl http://localhost:9222/json
```

Make sure TradingView has a chart open.

### TraderNote unauthorized

Check your `.env` values:

```env
TRADENOTE_APP_ID=
TRADENOTE_MASTER_KEY=
TRADENOTE_USER_ID=
```

Test manually:

```bash
curl -i "https://your-tradernote-domain.com/parse/classes/trades?limit=1" \
  -H "X-Parse-Application-Id: YOUR_APP_ID" \
  -H "X-Parse-Master-Key: YOUR_MASTER_KEY"
```

### Dashboard or Daily stops loading

A malformed object may have been inserted.

Find recent trade objects:

```bash
curl -s "https://your-tradernote-domain.com/parse/classes/trades?limit=5&order=-createdAt" \
  -H "X-Parse-Application-Id: YOUR_APP_ID" \
  -H "X-Parse-Master-Key: YOUR_MASTER_KEY"
```

Delete the bad object:

```bash
curl -X DELETE "https://your-tradernote-domain.com/parse/classes/trades/OBJECT_ID" \
  -H "X-Parse-Application-Id: YOUR_APP_ID" \
  -H "X-Parse-Master-Key: YOUR_MASTER_KEY"
```

### Screenshots upload but do not show under the trade

Screenshots must have:

```text
screenshots.name = trade.id
```

The script does this automatically.

Query screenshots:

```bash
curl -s "https://your-tradernote-domain.com/parse/classes/screenshots?limit=5&order=-createdAt" \
  -H "X-Parse-Application-Id: YOUR_APP_ID" \
  -H "X-Parse-Master-Key: YOUR_MASTER_KEY"
```

### Parse error about nested keys

Use the latest `tradenote.js`.

It sanitizes symbols:

```text
SOLUSDT.P → SOLUSDT_P
```

---

## Security

Never commit:

```text
.env
```

Do not expose:

- TraderNote App ID
- TraderNote Master Key
- MongoDB credentials
- screenshots with private trading data

Recommended:

```text
.env
screenshots/
node_modules/
```

should stay out of Git.

If you run TraderNote on a VPS, avoid exposing MongoDB publicly.

---

## Useful commands

Install:

```bash
npm install
```

Run:

```bash
node trade-monitor.js
```

Run through npm:

```bash
npm run monitor
```

Check TradingView debug:

```bash
curl http://localhost:9222/json/version
```

Check TraderNote Parse:

```bash
curl -i "https://your-tradernote-domain.com/parse/classes/trades?limit=1" \
  -H "X-Parse-Application-Id: YOUR_APP_ID" \
  -H "X-Parse-Master-Key: YOUR_MASTER_KEY"
```

---

## Example successful output

```text
🟢 POSITION OPENED
BINANCE:SOLUSDT.P Long qty:2000 entry:190.77
Charts: ./screenshots/entry-...

🔴 POSITION CLOSED exit:191.13
Logging replay trade to TraderNote: SOLUSDT.P Long 190.77 → 191.13

✅ TraderNote day object created: terReq4SlI
Trade ID: t1778734448_SOLUSDT_P_stock_B

✅ entry screenshot uploaded
✅ exit screenshot uploaded

🏆 TRADE LOGGED TO TRADERNOTE
```

---

## License

MIT
