/**
 * tab-probe.mjs
 * Uses CDP Network domain to intercept WebSocket frames directly
 * at the protocol level — no JS injection needed.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const CDP_PORT = parseInt(process.env.CDP_PORT || "9222");

export function cdpEval(wsUrl, expression, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), timeoutMs);
    try {
      let WS; try { WS = WebSocket; } catch { WS = require("ws"); }
      const ws = new WS(wsUrl);
      ws.onopen = () => ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: false }
      }));
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.id === 1) { ws.close(); finish(m.result?.result?.value ?? null); }
        } catch { finish(null); }
      };
      ws.onerror = () => finish(null);
    } catch { finish(null); }
  });
}

function parseFrames(raw) {
  const frames = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf("~m~", i);
    if (start === -1) break;
    const lenStart = start + 3;
    const lenEnd   = raw.indexOf("~m~", lenStart);
    if (lenEnd === -1) break;
    const len       = parseInt(raw.slice(lenStart, lenEnd), 10);
    const dataStart = lenEnd + 3;
    const data      = raw.slice(dataStart, dataStart + len);
    try { frames.push(JSON.parse(data)); } catch {}
    i = dataStart + len;
  }
  return frames;
}

function extractPosition(frame) {
  if (frame.m !== "du" || !frame.p?.[1]) return null;
  const payload = frame.p[1];
  for (const key in payload) {
    const ns = payload[key]?.ns;
    if (ns?.d?.includes("position")) {
      try {
        const parsed = JSON.parse(ns.d);
        const report = parsed?.data?.report;
        if (report?.position !== undefined) {

          // Trade structure: { e: {p, tm, c}, x: {p, tm, c}, q }
          // e = entry execution, x = exit execution
          // The last trade in report.trades is the most recent one.
          // When position closes (qty=0), last trade.x.p is the exact exit fill price.
          // When position is open, last trade.x.p is the running/projected exit.
          const trades = Array.isArray(report.trades) ? report.trades : [];
          const lastTrade = trades.length > 0 ? trades[trades.length - 1] : null;

          // Entry price of current trade (most recent entry execution)
          const lastEntryPrice = lastTrade?.e?.p ?? null;
          // Exit price of most recent closed trade (exact fill)
          const lastExitPrice  = lastTrade?.x?.p ?? null;
          // Exit comment — "Close position" means fully closed, "" means in-progress
          const lastExitComment = lastTrade?.x?.c ?? null;

          // Also check filledOrders for the most recent sell order fill price
          const filledOrders = Array.isArray(report.filledOrders) ? report.filledOrders : [];
          const lastSellOrder = filledOrders.filter(o => o.b === false).pop() || null;
          const filledSellPrice = lastSellOrder?.p ?? null;

          return {
            qty:              report.position.qty,
            price:            report.position.price,   // avg entry price of current open position
            openPL:           report.position.openPL,
            pct:              report.position.openPLPercent,
            currency:         report.currency,
            lastEntryPrice,   // entry fill price of most recent trade
            lastExitPrice,    // exit fill price of most recent trade (x.p)
            lastExitComment,  // "Close position" = fully closed, "" = open/in-progress
            filledSellPrice,  // most recent sell order fill from filledOrders
            tradesCount:      trades.length,
            ts:               Date.now(),
          };
        }
      } catch {}
    }
  }
  return null;
}

export class PositionMonitor {
  constructor(wsUrl) {
    this.wsUrl      = wsUrl;
    this.position   = null;
    this.onPosition = null;
    this._ws        = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      let WS; try { WS = WebSocket; } catch { WS = require("ws"); }
      const ws = new WS(this.wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
        ws.send(JSON.stringify({ id: 2, method: "Runtime.enable" }));
        resolve();
      };

      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.method === "Network.webSocketFrameReceived") {
            const payload = m.params?.response?.payloadData || "";
            if (payload.includes("position")) {
              const frames = parseFrames(payload);
              for (const f of frames) {
                const pos = extractPosition(f);
                if (pos !== null) {
                  const prev = this.position;
                  this.position = pos;

                  // Only fire callback on meaningful changes:
                  // 1. Open/close transition (0 <-> non-zero)
                  // 2. New exit price detected (trade completed)
                  const prevQty = prev?.qty ?? 0;
                  const curQty  = pos.qty ?? 0;
                  const openClose = (prevQty === 0) !== (curQty === 0);
                  const newExit   = pos.lastExitPrice && pos.lastExitPrice !== prev?.lastExitPrice;
                  const newEntry  = pos.lastEntryPrice && pos.lastEntryPrice !== prev?.lastEntryPrice;

                  if (openClose || newExit || newEntry) {
                    if (this.onPosition) this.onPosition(pos, prev);
                  }
                }
              }
            }
          }
        } catch {}
      };

      ws.onerror = (e) => reject(new Error("CDP WS error"));
      ws.onclose = () => {};
    });
  }

  stop() { if (this._ws) { this._ws.close(); this._ws = null; } }
  getPosition() { return this.position; }
}

export async function getSymbolDirect(wsUrl) {
  return await cdpEval(wsUrl,
    `(function(){ try{ return window.TradingViewApi._activeChartWidgetWV.value().symbol(); }catch(e){return null;} })()`,
    4000);
}

export async function getReplayState(wsUrl) {
  const raw = await cdpEval(wsUrl, `
    (function(){
      try {
        var wv=function(v){return(v&&typeof v==='object'&&typeof v.value==='function')?v.value():v;};
        var rp=window.TradingViewApi._replayApi;
        return JSON.stringify({started:!!(rp&&wv(rp.isReplayStarted())),date:rp?wv(rp.currentDate()):null});
      } catch(e){return JSON.stringify({started:false});}
    })()`, 4000);
  try { return JSON.parse(raw); } catch { return null; }
}

export async function getQuoteDirect(wsUrl) {
  const raw = await cdpEval(wsUrl, `
    (function(){
      try {
        var wv = function(v){ return (v&&typeof v==='object'&&typeof v.value==='function')?v.value():v; };
        var cw  = window.TradingViewApi._activeChartWidgetWV.value();
        var sym = cw.symbol();
        // Use _data from main series for last bar close price
        var ms  = cw._chartWidget.model().mainSeries();
        var lastBar = ms.bars().last();
        var close = lastBar ? lastBar.value[4] : null;
        return JSON.stringify({symbol:sym, close:close});
      } catch(e){return JSON.stringify({symbol:null,close:null,err:e.message});}
    })()`, 4000);
  try { return JSON.parse(raw); } catch { return null; }
}

export async function injectInterceptor(wsUrl) { return "using CDP Network"; }
export async function getPosition(wsUrl) { return { hooked: true, position: null }; }

export async function probeAllTabs(cdpPort = CDP_PORT) {
  const res    = await fetch(`http://localhost:${cdpPort}/json`);
  const all    = await res.json();
  const charts = all
    .filter(t => t.url?.startsWith("https://www.tradingview.com/chart/") && t.webSocketDebuggerUrl)
    .map(t => ({
      id:      t.id,
      chartId: t.url.match(/\/chart\/([^/]+)\//)?.[1] || "?",
      url:     t.url,
      wsUrl:   t.webSocketDebuggerUrl,
      symbol:  null,
      replay:  false,
    }));

  for (let i = 0; i < Math.min(3, charts.length); i++) {
    const sym = await getSymbolDirect(charts[i].wsUrl);
    if (sym) {
      charts[i].symbol = sym;
      const rs = await getReplayState(charts[i].wsUrl);
      charts[i].replay = rs?.started === true;
      break;
    }
  }
  return charts;
}
