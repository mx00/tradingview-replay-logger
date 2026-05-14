/**
 * tradenote.js
 * TraderNote direct API client with correct daily grouping.
 * One Parse trades object per trading day; multiple trades append to that day.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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

process.env.TZ = process.env.TRADENOTE_TIMEZONE || "America/New_York";

const BASE = (process.env.TRADENOTE_URL || "https://tradernote.velorasvc.com").replace(/\/$/, "");
const PARSE_BASE = `${BASE}/parse`;
const APP_ID = process.env.TRADENOTE_APP_ID;
const MASTER_KEY = process.env.TRADENOTE_MASTER_KEY || APP_ID;
const USER_ID = process.env.TRADENOTE_USER_ID;
const ACCOUNT = process.env.TRADENOTE_ACCOUNT || "TradingView Replay";
const CURRENCY = process.env.TRADENOTE_CURRENCY || "USD";
const SECURITY_TYPE = process.env.TRADENOTE_TYPE || "stock";

if (!APP_ID || !MASTER_KEY || !USER_ID) {
  throw new Error("Missing TRADENOTE_APP_ID, TRADENOTE_MASTER_KEY, or TRADENOTE_USER_ID in .env");
}

const HEADERS = {
  "X-Parse-Application-Id": APP_ID,
  "X-Parse-Master-Key": MASTER_KEY,
  "Content-Type": "application/json",
};

const userPointer = { __type: "Pointer", className: "_User", objectId: USER_ID };
const ACL = { [USER_ID]: { read: true, write: true } };

function asDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return d;
}

function unixExact(input) {
  return Math.floor(asDate(input).getTime() / 1000);
}

function unixLocalMidnight(input) {
  const d = asDate(input);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime() / 1000);
}

function cleanSymbol(raw) {
  if (!raw) return "UNKNOWN";
  const withoutExchange = String(raw).split(":").pop();
  return withoutExchange.replace(/[^a-zA-Z0-9_]/g, "_");
}

function tradeSymbolForId(symbol) {
  return cleanSymbol(symbol).replace(/[^a-zA-Z0-9_]/g, "_");
}

function sideCodes(side) {
  const isLong = String(side).toLowerCase() === "long";
  return {
    isLong,
    openSide: isLong ? "B" : "SS",
    closeSide: isLong ? "S" : "BC",
    strategy: isLong ? "long" : "short",
  };
}

async function parseRequest(method, pathPart, body) {
  const res = await fetch(`${PARSE_BASE}${pathPart}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathPart} failed: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function findTradeDay(dateUnix) {
  const where = encodeURIComponent(JSON.stringify({ dateUnix, user: userPointer }));
  const data = await parseRequest("GET", `/classes/trades?where=${where}&limit=1`);
  return data.results?.[0] || null;
}

function buildTradeParts(trade) {
  const symbol = cleanSymbol(trade.symbol);
  const symbolForId = tradeSymbolForId(symbol);
  const type = trade.type || SECURITY_TYPE;
  const quantity = Number(trade.quantity || trade.qty || 1);
  const entryPrice = Number(trade.entryPrice);
  const exitPrice = Number(trade.exitPrice);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) throw new Error("Invalid entry/exit price");

  const entryTime = unixExact(trade.entryTime);
  const exitTime = unixExact(trade.exitTime);
  const td = unixLocalMidnight(trade.entryTime);
  const dateIso = new Date(td * 1000).toISOString();
  const { isLong, openSide, closeSide, strategy } = sideCodes(trade.side);
  const entryProceeds = isLong ? -(quantity * entryPrice) : quantity * entryPrice;
  const exitProceeds = isLong ? quantity * exitPrice : -(quantity * exitPrice);
  const pnl = entryProceeds + exitProceeds;
  const win = pnl >= 0;

  const tradeId = `t${entryTime}_${symbolForId}_${type}_${openSide}`;
  const entryExecId = `e${entryTime}_${symbolForId}_${type}_${openSide}_1`;
  const exitExecId = `e${exitTime}_${symbolForId}_${type}_${closeSide}_1`;

  const commonExec = { account: ACCOUNT, broker: "template", td, sd: td, currency: CURRENCY, type, strategy, symbol, symbolOriginal: symbol, quantity, commission: 0, sec: 0, taf: 0, nscc: 0, nasdaq: 0, ecnRemove: 0, ecnAdd: 0, clrBroker: "TV" };
  const executions = [
    { ...commonExec, side: openSide, price: entryPrice, execTime: entryTime, id: entryExecId, grossProceeds: entryProceeds, netProceeds: entryProceeds, liq: "A", note: trade.entryNote || "Entry | TradingView replay", trade: tradeId },
    { ...commonExec, side: closeSide, price: exitPrice, execTime: exitTime, id: exitExecId, grossProceeds: exitProceeds, netProceeds: exitProceeds, liq: "R", note: trade.exitNote || "Exit | TradingView replay", trade: tradeId },
  ];

  const tradeObj = {
    id: tradeId, account: ACCOUNT, broker: "template", td, currency: CURRENCY, type, side: openSide, strategy,
    buyQuantity: quantity, sellQuantity: quantity, symbol, symbolOriginal: symbol, entryTime, exitTime, entryPrice, exitPrice,
    commissionOpen: 0, commission: 0, secOpen: 0, sec: 0, tafOpen: 0, taf: 0, nsccOpen: 0, nscc: 0, nasdaqOpen: 0, nasdaq: 0,
    ecnRemoveOpen: 0, ecnRemove: 0, ecnAddOpen: 0, ecnAdd: 0, clrBroker: "TV", liq: "A",
    grossEntryProceedsOpen: 0, grossEntryProceeds: entryProceeds, grossExitProceedsOpen: 0, grossExitProceeds: exitProceeds,
    grossProceedsOpen: 0, grossProceeds: pnl, grossWins: win ? pnl : 0, grossLoss: win ? 0 : pnl, grossSharePL: pnl / quantity,
    grossSharePLWins: win ? pnl / quantity : 0, grossSharePLLoss: win ? 0 : pnl / quantity, grossStatus: win ? "win" : "loss",
    netEntryProceedsOpen: 0, netEntryProceeds: entryProceeds, netExitProceedsOpen: 0, netExitProceeds: exitProceeds,
    netProceedsOpen: 0, netProceeds: pnl, netWins: win ? pnl : 0, netLoss: win ? 0 : pnl, netSharePL: pnl / quantity,
    netSharePLWins: win ? pnl / quantity : 0, netSharePLLoss: win ? 0 : pnl / quantity, netStatus: win ? "win" : "loss",
    executionsCount: 2, tradesCount: 1,
    grossWinsQuantity: win ? quantity : 0, grossLossQuantity: win ? 0 : quantity, grossWinsCount: win ? 1 : 0, grossLossCount: win ? 0 : 1,
    netWinsQuantity: win ? quantity : 0, netLossQuantity: win ? 0 : quantity, netWinsCount: win ? 1 : 0, netLossCount: win ? 0 : 1,
    note: trade.note || "", executions: [entryExecId, exitExecId], openPosition: false,
  };
  return { td, dateIso, symbol, tradeId, executions, tradeObj, pnl, entryTime, exitTime };
}

function emptyStats() {
  return { buyQuantity: 0, sellQuantity: 0, commission: 0, sec: 0, taf: 0, nscc: 0, nasdaq: 0, otherCommission: 0, fees: 0, grossProceeds: 0, grossWins: 0, grossLoss: 0, grossSharePL: 0, grossSharePLWins: 0, grossSharePLLoss: 0, highGrossSharePLWin: 0, highGrossSharePLLoss: 0, netProceeds: 0, netWins: 0, netLoss: 0, netSharePL: 0, netSharePLWins: 0, netSharePLLoss: 0, highNetSharePLWin: 0, highNetSharePLLoss: 0, executions: 0, trades: 0, grossWinsQuantity: 0, grossLossQuantity: 0, grossWinsCount: 0, grossLossCount: 0, netWinsQuantity: 0, netLossQuantity: 0, netWinsCount: 0, netLossCount: 0 };
}

function addTradeToStats(target, t) {
  for (const k of ["buyQuantity","sellQuantity","commission","sec","taf","nscc","nasdaq","otherCommission","fees","grossProceeds","grossWins","grossLoss","grossSharePL","grossSharePLWins","grossSharePLLoss","netProceeds","netWins","netLoss","netSharePL","netSharePLWins","netSharePLLoss","grossWinsQuantity","grossLossQuantity","grossWinsCount","grossLossCount","netWinsQuantity","netLossQuantity","netWinsCount","netLossCount"]) target[k] += t[k] || 0;
  target.highGrossSharePLWin = Math.max(target.highGrossSharePLWin || 0, t.grossSharePLWins || 0);
  target.highGrossSharePLLoss = Math.min(target.highGrossSharePLLoss || 0, t.grossSharePLLoss || 0);
  target.highNetSharePLWin = Math.max(target.highNetSharePLWin || 0, t.netSharePLWins || 0);
  target.highNetSharePLLoss = Math.min(target.highNetSharePLLoss || 0, t.netSharePLLoss || 0);
  target.executions += t.executionsCount || 0;
  target.trades += t.tradesCount || 0;
}

function recalc(trades) {
  const blotter = {};
  const pAndL = emptyStats();
  for (const t of trades) {
    if (!blotter[t.symbol]) blotter[t.symbol] = { symbol: t.symbol, type: t.type, ...emptyStats() };
    addTradeToStats(blotter[t.symbol], t);
    addTradeToStats(pAndL, t);
  }
  return { blotter, pAndL };
}

async function upsertTradeDay(trade) {
  const parts = buildTradeParts(trade);
  const existing = await findTradeDay(parts.td);
  if (!existing) {
    const { blotter, pAndL } = recalc([parts.tradeObj]);
    const payload = { user: userPointer, ACL, date: { __type: "Date", iso: parts.dateIso }, dateUnix: parts.td, executions: parts.executions, trades: [parts.tradeObj], blotter, pAndL, openPositions: false };
    const created = await parseRequest("POST", "/classes/trades", payload);
    return { action: "created", objectId: created.objectId, ...parts };
  }
  const oldTrades = existing.trades || [];
  if (oldTrades.some(t => t.id === parts.tradeId)) return { action: "skipped_duplicate", objectId: existing.objectId, ...parts };
  const trades = [...oldTrades, parts.tradeObj];
  const executions = [...(existing.executions || []), ...parts.executions];
  const { blotter, pAndL } = recalc(trades);
  await parseRequest("PUT", `/classes/trades/${existing.objectId}`, { executions, trades, blotter, pAndL, openPositions: false });
  return { action: "updated", objectId: existing.objectId, ...parts };
}

async function screenshotDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let source = filePath;
  const ext = path.extname(filePath);
  const tmp = filePath.replace(ext, "_tradenote.jpg");
  try {
    execSync(`sips -Z 1280 --setProperty formatOptions 60 --setProperty format jpeg "${filePath}" --out "${tmp}" 2>/dev/null`, { stdio: "ignore" });
    if (fs.existsSync(tmp)) source = tmp;
  } catch {}
  const raw = fs.readFileSync(source);
  const mime = source.toLowerCase().endsWith(".jpg") || source.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
  const out = `data:${mime};base64,${raw.toString("base64")}`;
  console.log(`   📸 Screenshot payload: ${Math.round(raw.length / 1024)} KB`);
  if (source === tmp) { try { fs.unlinkSync(tmp); } catch {} }
  return out;
}

async function uploadScreenshot(filePath, label, info) {
  const dataUrl = await screenshotDataUrl(filePath);
  if (!dataUrl) return null;
  const dateUnix = label === "entry" ? info.entryTime : info.exitTime;
  const payload = { user: userPointer, ACL, side: label, name: info.tradeId, symbol: info.symbol, originalBase64: dataUrl, annotatedBase64: dataUrl, markersOnly: false, date: { __type: "Date", iso: new Date(dateUnix * 1000).toISOString() }, dateUnix, dateUnixDay: info.td };
  const created = await parseRequest("POST", "/classes/screenshots", payload);
  console.log(`   ✅ ${label} screenshot uploaded: ${created.objectId}`);
  return created;
}

export async function logReplayTrade(trade, entryScreenshotPath, exitScreenshotPath) {
  console.log(`📤 Logging replay trade to TraderNote: ${trade.symbol} ${trade.side} ${trade.entryPrice} → ${trade.exitPrice}`);
  const result = await upsertTradeDay(trade);
  console.log(`✅ TraderNote day object ${result.action}: ${result.objectId}`);
  console.log(`   Trade ID: ${result.tradeId}`);
  let entryShot = null, exitShot = null;
  if (entryScreenshotPath) entryShot = await uploadScreenshot(entryScreenshotPath, "entry", result);
  if (exitScreenshotPath) exitShot = await uploadScreenshot(exitScreenshotPath, "exit", result);
  console.log(`\n${"═".repeat(52)}\n  🏆 TRADE LOGGED TO TRADERNOTE\n${"═".repeat(52)}`);
  console.log(`  ${trade.symbol} ${trade.side} ${trade.entryPrice} → ${trade.exitPrice}`);
  console.log(`  PnL: ${result.pnl >= 0 ? "+" : ""}${result.pnl.toFixed(4)}`);
  console.log(`  Day object: ${result.objectId}`);
  console.log(`  Trade ID:   ${result.tradeId}`);
  if (entryShot?.objectId) console.log(`  Entry SS:   ${entryShot.objectId}`);
  if (exitShot?.objectId) console.log(`  Exit SS:    ${exitShot.objectId}`);
  console.log(`  View: ${BASE}\n${"═".repeat(52)}\n`);
  return { ...result, entryScreenshot: entryShot, exitScreenshot: exitShot };
}

export { buildTradeParts, upsertTradeDay, uploadScreenshot };
