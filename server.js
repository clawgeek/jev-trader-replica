#!/usr/bin/env node
/**
 * jev-trader-replica · server.js
 * ---------------------------------------------------------------------------
 * 复刻 jarrodwatts/jev-trader（https://github.com/jarrodwatts/jev-trader）
 * 的模拟盘实现：每个区块读盘口 → 压缩成紧凑状态 → 决策模型给出买/卖 →
 * 挂一单 post-only 限价单（盘口内侧 1 tick，并撤销上一单）→ 模拟成交 → 盈亏核算。
 *
 * 与原版差异（见 README.md）：
 *  - 行情源为内置模拟器（本环境无法访问 Monad/Kuru 公共 RPC；原版默认也是 dry-run）
 *  - 决策模型为原版同款 MockModel（动量 + 盘口失衡 + 主动成交流 + 噪声 → sigmoid）
 *  - 接入真实 JEV：设置 MODEL=jev 与 TYPESAFE_AI_API_KEY（需要 ai SDK），见 README
 *
 * 零第三方依赖，Node 18+ 直接运行： node server.js
 * 端点：
 *   GET /           看板（dashboard.html）
 *   GET /snapshot   当前快照 { model, wallet, dryRun, latest }
 *   GET /history    最近 1000 个区块事件
 *   GET /events     SSE：连接即发 snapshot，之后每个区块发 block，成交发 fill
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ============================== 配置 ============================== */
const env = (k, f) => process.env[k] ?? f;
const config = {
  tradeSizeMon: Number(env('TRADE_SIZE_MON', '200')),   // 每单 200 MON（Kuru 最小下单量）
  maxPositionMon: Number(env('MAX_POSITION_MON', '1000')),
  bankrollUsd: Number(env('BANKROLL_USD', '100')),      // pnlPct 的分母
  quoteInsideTicks: Number(env('QUOTE_INSIDE_TICKS', '1')), // 挂到盘口内侧 1 tick
  horizonBlocks: Number(env('HORIZON_BLOCKS', '100')),  // 模型被问的窗口（~30 秒）
  blockMs: Number(env('BLOCK_MS', '300')),              // 模拟出块间隔（Monad ~300ms）
  tick: 1e-6,                                           // MON-USDC 最小价格跳动
  gasMonPerQuote: 0.0357,   // 原版 dry-run 实测每次挂单 gas（Monad 按 gas limit 计费）
  jevUsdPerMTok: 0.042,     // JEV 官方定价：每百万 token 0.042 美元
  latencyBaseMs: 80,        // mock 推理基准延迟（原版固定 80ms）
  latencySpikePct: 0.08,    // 8% 概率延迟冲到 220–480ms，模拟 JEV 70–500ms 抖动与 late 区块
  model: env('MODEL', 'mock'),          // mock | jev
  jevModelId: env('JEV_MODEL_ID', 'jev-latest'),
  port: Number(env('PORT', '3000')),
  historySize: 1000,
};

/* ========================== 模拟盘口（Kuru MON-USDC） ========================== */
const SIM = {
  mid: 0.022636,
  momentum: 0,
  prints: [],      // 近 horizon 主动成交（taker prints）
  printBlocks: [], // 每条 print 所属区块
  vols: [0.9, 0.95, 1.05, 1.1], // 状态切换时的波动倍率
};
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** 推进一个区块的模拟行情：状态回归 + 随机游走 + 生成盘口与主动成交 */
function stepMarket(block) {
  SIM.momentum = 0.92 * SIM.momentum + gauss() * 0.0007;
  if (Math.random() < 0.008) SIM.momentum *= rnd(-1.2, -0.8); // 偶尔反转
  const drift = Math.exp(SIM.momentum * 0.6 + gauss() * 0.00012);
  SIM.mid = clamp(SIM.mid * drift, 0.018, 0.028);

  const spreadBps = rnd(5, 11) * (Math.random() < 0.08 ? 1.8 : 1);
  const half = (SIM.mid * spreadBps) / 2 / 1e4;
  const bid0 = SIM.mid - half, ask0 = SIM.mid + half;
  const lvl = (base, k) => ({ price: Math.max(1e-6, base - k * config.tick), size: Math.round(rnd(120, 2200)) });
  const bids = [0, 1, 2, 3, 4].map((k) => lvl(bid0, k));
  const asks = [0, 1, 2, 3, 4].map((k) => lvl(ask0, -k));
  const bestBid = bids[0].price, bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;

  // 深度带：10/25/50 bps 内累计挂单量（每侧）
  const depthBps = {};
  for (const b of [10, 25, 50]) {
    const bb = SIM.mid * b / 1e4;
    depthBps[b] = {
      bid: bids.filter((l) => l.price >= mid - bb).reduce((s, l) => s + l.size, 0),
      ask: asks.filter((l) => l.price <= mid + bb).reduce((s, l) => s + l.size, 0),
    };
  }
  const bidVol = depthBps[25].bid, askVol = depthBps[25].ask;
  const imbalance = bidVol + askVol ? (bidVol - askVol) / (bidVol + askVol) : 0;

  // 主动成交（taker prints）：数量 0–3，方向偏向当前动量
  const nPrints = Math.random() < 0.15 ? 0 : 1 + Math.floor(Math.random() * 3);
  const buyBias = clamp(SIM.momentum * 140 + gauss() * 0.55, -0.75, 0.75);
  for (let i = 0; i < nPrints; i++) {
    const buy = Math.random() < (buyBias + 1) / 2;
    const price = buy ? bestAsk + rnd(0, 2) * config.tick : bestBid - rnd(0, 2) * config.tick;
    SIM.prints.push({ block, side: buy ? 'buy' : 'sell', size: round(rnd(30, 320), 1), price });
    SIM.printBlocks.push(block);
  }
  // 只保留近 200 个区块的 prints
  while (SIM.printBlocks.length && block - SIM.printBlocks[0] > 200) {
    SIM.prints.shift(); SIM.printBlocks.shift();
  }

  return {
    mid, bestBid, bestAsk, spreadBps: round(spreadBps, 2), imbalance: round(imbalance, 3),
    depthBps, bids, asks,
  };
}

/** 近 H 个区块的主动成交统计（与原版 trades.summary 对齐） */
function tradesSummary(H, block) {
  let buyMon = 0, sellMon = 0, count = 0, vwapNum = 0, vwapDen = 0, lastPrice = null, lastSide = null;
  for (let i = SIM.prints.length - 1; i >= 0; i--) {
    if (block - SIM.prints[i].block > H) break;
    const p = SIM.prints[i];
    count++;
    if (p.side === 'buy') buyMon += p.size; else sellMon += p.size;
    vwapNum += p.size * p.price; vwapDen += p.size;
    lastPrice = p.price; lastSide = p.side;
  }
  return {
    count, buyMon: round(buyMon, 1), sellMon: round(sellMon, 1),
    cvdMon: round(buyMon - sellMon, 1),
    vwap: vwapDen ? round(vwapNum / vwapDen, 6) : null,
    lastPrice, lastSide,
  };
}

/* ============================ 决策模型 ============================ */
/**
 * MockModel —— 与原版 src/model.ts 逐行一致：
 * signal = last20收益/8 + 盘口失衡*1.5 + 主动成交流*2 + 噪声；buy = sigmoid(signal)
 */
class MockModel {
  constructor() { this.name = 'mock'; }
  async decide(state, block) {
    const t0 = performance.now();
    const flow = state.trades.buyMon + state.trades.sellMon
      ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(block);
    const buy = 1 / (1 + Math.exp(-signal));
    const action = buy >= 0.5 ? 'buy' : 'sell';
    // 模拟推理延迟：基准 80ms，偶尔冲高（模拟 JEV 70–500ms），用于演示 late 区块路径
    const spike = Math.random() < config.latencySpikePct ? rnd(220, 480) : 0;
    await new Promise((r) => setTimeout(r, config.latencyBaseMs + spike));
    return {
      action,
      probabilities: { buy, sell: 1 - buy, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }
  noise(block) {
    let h = (block * 2654435761) >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

class JevModel {
  constructor() { this.name = config.jevModelId; }
  async decide() {
    throw new Error(
      'MODEL=jev 需要 ai SDK 与 TYPESAFE_AI_API_KEY（TypeSafe Jev 官方模型）。' +
      '本复刻默认用 mock 启发式模型，接入方式见 README.md。'
    );
  }
}
const createModel = () => (config.model === 'jev' ? new JevModel() : new MockModel());

/* ============================ Trader 主循环 ============================ */
/** 与原版 src/trader.ts 逻辑对齐的模拟盘交易器 */
class Trader {
  constructor(model) {
    this.model = model;
    this.history = [];
    this.mids = [];
    this.busy = false;
    this.lastBook = null;
    this.orders = new Map();   // 挂在盘口上的订单
    this.simId = 0;
    this.pendingFills = [];
    this.position = { mon: 0, costUsd: 0 };
    this.totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };
    this.listeners = { block: [], fill: [] };
  }
  onBlock(cb) { this.listeners.block.push(cb); }
  onFill(cb) { this.listeners.fill.push(cb); }

  async tick(block) {
    this.totals.blocks++;
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, null, true);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = stepMarket(block);          // 本区块行情（含 taker prints）
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.harvest(block);                     // 用本区块 prints 对上一区块起的挂单模拟成交

      const state = this.buildState(block, book);
      let decision;
      try {
        decision = await this.model.decide(state, block);
      } catch (e) {
        console.error(`[model] ${e.message}`);
        decision = { action: 'buy', probabilities: { buy: 0.5, sell: 0.5, hold: 0 }, upIn10: 0.5, latencyMs: 0, inputTokens: 0 };
      }
      const wanted = decision.action === 'sell' ? 'sell' : 'buy';
      const other = wanted === 'buy' ? 'sell' : 'buy';
      const side = this.allowed(wanted, book) ? wanted : this.allowed(other, book) ? other : null;
      this.totals.decisions++;
      this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;

      let quote = null;
      if (side) {
        decision.action = side;
        const capped = side !== wanted;
        quote = this.send(block, side, book, capped);
        this.totals.quotes++;
        this.totals.gasMon += config.gasMonPerQuote; // 原版：receipt 到达即计 gas（revert 也计）
        if (quote.status === 'sim') {
          this.orders.clear(); // batchUpdate：撤销上一单
          this.orders.set(--this.simId, { side, price: quote.price, size: quote.size, block });
        }
      }
      this.emit(block, book, decision, quote, false, {
        readMs: Math.round(readMs),
        loopMs: Math.round(performance.now() - t0),
      });
    } catch (e) {
      console.error(`block ${block}:`, e.message);
    } finally {
      this.busy = false;
    }
  }

  /** 模拟成交：taker 主动成交若穿过我们挂的单，先吃我们的（原版 simFills 同规则） */
  harvest(block) {
    const prints = SIM.prints.filter((p) => p.block === block);
    const fills = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        const hit = o.side === 'buy' ? p.side === 'sell' && p.price <= o.price
                                     : p.side === 'buy' && p.price >= o.price;
        if (!hit) continue;
        const size = Math.min(o.size, p.size);
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        fills.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, block });
      }
    }
    this.pendingFills = fills;
    for (const f of fills) this.applyFill(f);
    this.totals.fills += fills.length;
  }

  send(block, side, book, capped) {
    // post-only 限价单：挂到盘口内侧 quoteInsideTicks 个 tick，价差太窄则收敛到 touch
    const touch = side === 'buy' ? book.bestBid : book.bestAsk;
    let price = side === 'buy'
      ? touch + config.quoteInsideTicks * config.tick
      : touch - config.quoteInsideTicks * config.tick;
    if (side === 'buy' && price >= book.bestAsk) price = touch;
    if (side === 'sell' && price <= book.bestBid) price = touch;
    return { side, price, size: config.tradeSizeMon, status: 'sim', txHash: null, orderId: null, capped: !!capped };
  }

  allowed(side, book) {
    const size = config.tradeSizeMon;
    const exposure = side === 'buy'
      ? this.position.mon + this.restingMon('buy') + size
      : this.position.mon - this.restingMon('sell') - size;
    return Math.abs(exposure) <= config.maxPositionMon;
  }

  restingMon(side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    return mon;
  }

  buildState(block, book) {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k) => (n > k ? ((m[n - 1] - m[n - 1 - k]) / m[n - 1 - k]) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0);
    const lvl = (l) => `${l.price.toFixed(6)} x ${round(l.size, 1)}`;
    const depth = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + 'bps'] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    const trades = tradesSummary(H, block);
    return {
      market: 'MON-USDC', block, horizonBlocks: H, blockMs: config.blockMs,
      mid: book.mid, spreadBps: round(book.spreadBps, 2), bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.bids.map(lvl), asks: book.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(' '),
      trades,
      recentTrades: SIM.prints.slice(-10).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      allowed: { buy: this.allowed('buy', book), sell: this.allowed('sell', book) },
    };
  }

  applyFill(f) {
    if (f.size <= 0) return;
    const signed = f.side === 'buy' ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry);
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price;
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
  }

  entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  unrealizedUsd(mid) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()) : 0; }

  emit(block, book, decision, quote, late, timing) {
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd;
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const fill = this.pendingFills && this.pendingFills.length ? aggregate(this.pendingFills) : null;
    this.pendingFills = [];
    const event = {
      block, ts: Date.now(), mid: round(book.mid, 6), bestBid: round(book.bestBid, 6), bestAsk: round(book.bestAsk, 6),
      spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: 'hold', probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: round(decision.upIn10, 4), latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      fill,
      resting: { bidMon: round(this.restingMon('buy'), 1), askMon: round(this.restingMon('sell'), 1) },
      position: {
        side: this.position.mon > 0 ? 'long' : this.position.mon < 0 ? 'short' : 'flat',
        size, entryPrice: this.entryPrice() ? round(this.entryPrice(), 6) : null,
        unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: {
        blocks: t.blocks, decisions: t.decisions, quotes: t.quotes, fills: t.fills, reverted: t.reverted,
        lateBlocks: t.lateBlocks, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6),
        realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3),
      },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    if (timing) event.timing = timing;
    if (fill) this.listeners.fill.forEach((cb) => cb(block, fill));
    this.listeners.block.forEach((cb) => cb(event, timing));
  }
}

/** 一个区块多条成交合并为一条：总手数、按量加权价、量多的一侧（与原版 aggregate 一致） */
function aggregate(fills) {
  const buy = fills.filter((f) => f.side === 'buy').reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === 'sell').reduce((s, f) => s + f.size, 0);
  const side = buy >= sell ? 'buy' : 'sell';
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: null, orderId: null, simulated: true };
}

/* ============================== HTTP 服务 ============================== */
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
const dashboardHtml = fs.existsSync(DASHBOARD_PATH) ? fs.readFileSync(DASHBOARD_PATH, 'utf8') : null;

function start() {
  const model = createModel();
  const trader = new Trader(model);
  let block = 105_488_200;
  const clients = new Set();

  trader.onBlock((event) => {
    for (const res of clients) sse(res, 'block', event);
  });
  trader.onFill((blk, fill) => {
    for (const res of clients) sse(res, 'fill', { block: blk, fill });
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      if (!dashboardHtml) { res.writeHead(404); res.end('dashboard.html 不存在'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml);
    } else if (url.pathname === '/snapshot') {
      const latest = trader.history[trader.history.length - 1] ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ model: model.name, wallet: null, dryRun: true, latest }));
    } else if (url.pathname === '/history') {
      const n = Math.min(Number(url.searchParams.get('n')) || 1000, config.historySize);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(trader.history.slice(-n)));
    } else if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      const latest = trader.history[trader.history.length - 1] ?? null;
      sse(res, 'snapshot', { model: model.name, wallet: null, dryRun: true, latest });
      clients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
    } else {
      res.writeHead(404); res.end('not found');
    }
  });

  setInterval(() => { trader.tick(++block).catch((e) => console.error(e)); }, config.blockMs);
  server.listen(config.port, () => {
    console.log(`jev-trader-replica 运行中  http://localhost:${config.port}`);
    console.log(`model=${model.name}  dryRun=true  blockMs=${config.blockMs}  每个区块: 读盘口→决策→挂单`);
  });
}
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
}
start();
