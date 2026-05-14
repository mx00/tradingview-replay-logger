#!/usr/bin/env node
/**
 * trade-monitor.js
 * Watches TradingView replay position changes through CDP WebSocket events.
 * Requires existing `tab-probe.mjs` in the same folder.
 */

import { execSync } from "child_process";
import * as readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { probeAllTabs, getSymbolDirect, getReplayState, getQuoteDirect, PositionMonitor } from "./tab-probe.mjs";
import { logReplayTrade } from "./tradenote.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
}

const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const SHOTS_DIR = process.env.SCREENSHOTS_DIR ? path.resolve(process.env.SCREENSHOTS_DIR) : path.join(__dirname, "screenshots");
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

function resolveTvCli() {
  if (process.env.TV_CLI_PATH) { const p = path.resolve(process.env.TV_CLI_PATH); if (fs.existsSync(p)) return p; }
  if (process.env.TV_MCP_PATH) { const p = path.join(path.resolve(process.env.TV_MCP_PATH), "src", "cli", "index.js"); if (fs.existsSync(p)) return p; }
  const s = path.join(__dirname, "..", "tradingview-mcp", "src", "cli", "index.js");
  if (fs.existsSync(s)) return s;
  return null;
}
const TV_CLI = resolveTvCli();

function tvCli(command, args = {}) {
  const argStr = Object.entries(args).map(([k, v]) => `--${k} ${JSON.stringify(String(v))}`).join(" ");
  const cmd = TV_CLI ? `node "${TV_CLI}" ${command} ${argStr} 2>/dev/null` : `tv ${command} ${argStr} 2>/dev/null`;
  try { const o = execSync(cmd, { encoding: "utf8", timeout: 8000 }).trim(); return o ? JSON.parse(o) : null; } catch { return null; }
}

async function takeScreenshot(tag) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const mode = (process.env.SCREENSHOT_MODE || "full").toLowerCase();
  if (mode === "mcp") {
    const dest = path.join(SHOTS_DIR, `${tag}-${ts}.png`);
    tvCli("screenshot", { region: "chart" });
    const mcpShots = path.join(process.env.TV_MCP_PATH ? path.resolve(process.env.TV_MCP_PATH) : path.join(__dirname, "..", "tradingview-mcp"), "screenshots");
    if (fs.existsSync(mcpShots)) {
      const files = fs.readdirSync(mcpShots).filter(f => f.endsWith(".png")).map(f => ({ f, t: fs.statSync(path.join(mcpShots, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      if (files.length) { fs.copyFileSync(path.join(mcpShots, files[0].f), dest); return [dest]; }
    }
    return [];
  }
  const dest = path.join(SHOTS_DIR, `${tag}-${ts}.png`);
  const captured = await cdpScreenshot(TRACKED.wsUrl, dest);
  if (!captured) { console.warn("   ⚠️ CDP screenshot failed"); return []; }
  return [captured];
}

function cdpScreenshot(wsUrl, dest) {
  return new Promise((resolve) => {
    let WS; try { WS = WebSocket; } catch { WS = require("ws"); }
    const ws = new WS(wsUrl);
    let done = false, msgId = 1;
    const finish = v => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    setTimeout(() => finish(null), 10000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: msgId++, method: "Page.enable" }));
      setTimeout(() => ws.send(JSON.stringify({ id: msgId++, method: "Page.captureScreenshot", params: { format: "png", quality: 90, captureBeyondViewport: false } })), 200);
    };
    ws.onmessage = e => {
      try { const m = JSON.parse(e.data); if (m.result?.data) { fs.writeFileSync(dest, Buffer.from(m.result.data, "base64")); finish(dest); } } catch {}
    };
    ws.onerror = () => finish(null);
  });
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, answer => { rl.close(); resolve(answer.trim()); }));
}

function formatSymbol(raw) {
  if (!raw) return "UNKNOWN";
  return String(raw).split(":").pop();
}

let state = { inTrade: false, symbol: null, rawSymbol: null, side: null, quantity: null, entryPrice: null, entryTime: null, entryScreenshots: [] };
let TRACKED;

async function onOpen(pos) {
  const rawSym = TRACKED.symbol || "UNKNOWN";
  const sym = formatSymbol(rawSym);
  const side = pos.qty > 0 ? "Long" : "Short";
  const qty = Math.abs(pos.qty);
  const price = pos.price;
  const time = new Date().toISOString();
  console.log("\n🟢 POSITION OPENED");
  console.log(`   ${rawSym} ${side} qty:${qty} entry:${price} currency:${pos.currency || "?"}`);
  const shots = await takeScreenshot("entry");
  console.log(`   Charts: ${shots.length ? shots.join(", ") : "none"}`);
  console.log("⏳ Waiting for close…\n");
  state = { inTrade: true, symbol: sym, rawSymbol: rawSym, side, quantity: qty, entryPrice: price, entryTime: time, entryScreenshots: shots };
}

async function onClose(pos, prevPos) {
  if (!state.inTrade) { console.log("   ℹ️ Ignoring close — no open trade tracked"); return; }
  const exitTime = new Date().toISOString();
  const quote = await getQuoteDirect(TRACKED.wsUrl);
  const exitPrice = pos.lastExitPrice || prevPos?.lastExitPrice || pos.filledSellPrice || prevPos?.filledSellPrice || quote?.close || state.entryPrice;
  const exitSrc = pos.lastExitPrice ? "trade.x.p exact" : pos.filledSellPrice ? "filledOrders fill" : "quote close approx";
  console.log(`\n🔴 POSITION CLOSED exit:${exitPrice} [${exitSrc}] TV PnL:${pos.openPL ?? "n/a"}`);
  const exitShots = await takeScreenshot("exit");
  const trade = { symbol: state.symbol, side: state.side, quantity: state.quantity, entryPrice: state.entryPrice, exitPrice, entryTime: state.entryTime, exitTime, tags: ["replay", "tradingview", (state.symbol || "unknown").toLowerCase().replace(/[^a-z0-9]/g, ""), state.side.toLowerCase()] };
  try {
    const entryShot = state.entryScreenshots[0] || null;
    const exitShot = exitShots[0] || null;
    await logReplayTrade(trade, entryShot, exitShot);
  } catch (e) { console.error("❌ Failed to log:", e.message); }
  state = { inTrade: false, symbol: null, rawSymbol: null, side: null, quantity: null, entryPrice: null, entryTime: null, entryScreenshots: [] };
}

async function main() {
  console.log("═".repeat(52));
  console.log("  TradingView → TraderNote Replay Monitor");
  console.log("  CDP position monitor + full-window screenshots");
  console.log("═".repeat(52));
  console.log(`  Screenshots: ${SHOTS_DIR}`);
  console.log(`  Screenshot mode: ${process.env.SCREENSHOT_MODE || "full"}`);
  console.log("─".repeat(52));

  if (process.env.TV_TARGET_ID) {
    const res = await fetch(`http://localhost:${CDP_PORT}/json`);
    const all = await res.json();
    const found = all.find(t => t.id === process.env.TV_TARGET_ID);
    if (found) {
      TRACKED = { id: found.id, chartId: found.url.match(/\/chart\/([^/]+)\//)?.[1] || "?", wsUrl: found.webSocketDebuggerUrl, symbol: null };
      TRACKED.symbol = await getSymbolDirect(TRACKED.wsUrl) || TRACKED.chartId;
      console.log(`  Preset target: ${TRACKED.symbol} (${TRACKED.id.slice(0, 8)}…)`);
    }
  }

  if (!TRACKED) {
    console.log("  Fetching open chart tabs…");
    let tabs;
    try { tabs = await probeAllTabs(CDP_PORT); } catch (e) { console.error("❌ CDP error:", e.message); process.exit(1); }
    if (!tabs.length) { console.error("❌ No chart tabs found."); process.exit(1); }
    console.log(`\n  Found ${tabs.length} TradingView chart tabs:\n`);
    tabs.forEach((t, i) => {
      const label = t.symbol ? t.symbol.padEnd(26) : (`chart/${t.chartId}`).padEnd(26);
      const active = t.symbol ? " ← active" : "";
      const replay = t.replay ? " 🔄 REPLAY" : "";
      console.log(`  [${String(i + 1).padStart(2)}] ${label}${replay}${active}`);
    });
    let chosen = null;
    while (!chosen) {
      const a = await prompt(`\n  Which tab to track? (1-${tabs.length}): `);
      const n = parseInt(a, 10);
      if (n >= 1 && n <= tabs.length) chosen = tabs[n - 1]; else console.log(`  Enter 1–${tabs.length}`);
    }
    TRACKED = chosen;
    if (!TRACKED.symbol) {
      console.log(`\n  Click chart/${TRACKED.chartId} in TradingView (3s)…`);
      await new Promise(r => setTimeout(r, 3000));
      TRACKED.symbol = await getSymbolDirect(TRACKED.wsUrl) || TRACKED.chartId;
    }
  }

  console.log(`\n✅ Tracking: ${TRACKED.symbol} (${TRACKED.id.slice(0, 8)}…)`);
  console.log(`   https://www.tradingview.com/chart/${TRACKED.chartId}/`);
  console.log("\n  Starting CDP Network frame capture…");
  const monitor = new PositionMonitor(TRACKED.wsUrl);
  monitor.onPosition = async (pos, prev) => {
    const wasFlat = !prev || prev.qty === 0;
    const isFlat = pos.qty === 0;
    const flipped = !wasFlat && !isFlat && Math.sign(prev.qty) !== Math.sign(pos.qty);
    if (wasFlat && !isFlat) await onOpen(pos);
    else if (!wasFlat && isFlat) await onClose(pos, prev);
    else if (flipped) { await onClose(pos, prev); await onOpen(pos); }
  };
  await monitor.start();
  console.log("✅ CDP Network capture active");
  const rs = await getReplayState(TRACKED.wsUrl);
  if (rs?.started) console.log(`✅ Replay active (date: ${rs.date ? new Date(rs.date * 1000).toISOString().slice(0, 10) : "?"})`);
  else console.log("ℹ️ Replay not active — start it in TradingView when ready.");
  console.log("\n  💡 Skip picker next time — add to .env:");
  console.log(`     TV_TARGET_ID=${TRACKED.id}`);
  console.log("\n  Just click Buy/Sell in TradingView — trades log automatically.");
  console.log("👁 Watching…\n");
  process.on("SIGINT", () => { monitor.stop(); process.exit(0); });
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
