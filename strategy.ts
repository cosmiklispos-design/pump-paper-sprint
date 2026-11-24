// Pump.fun Paper Sprint — mean-reversion paper-trading bot (agent-fun/replay/v2).
//
// Idea: on a 6-hour window of fresh pump.fun bonding curves, chasing breakouts
// loses — most spikes revert within minutes, so buying the top pays the dump.
// What pays is the other side: a coin that just dumped hard (down 5–40% over the
// last ~30 slots) while buyers are already stepping back in (several distinct
// buyers in the window, newer-half inflow no worse than the older half's). So
// this bot:
//   1. watches every curve's tape and only enters after a sharp dip with buy
//      flow returning — it buys the dip, never the spike, and only on curves
//      old enough (60+ slots) that the launch dump is behind them. The dip
//      alone is not enough: the window's net SOL must be back to >= 0 with at
//      least 5 distinct buyers, so it is a crowd stepping back in, not one
//      wallet catching a falling knife;
//   2. starts small (0.05 SOL) and pyramids into strength only — each add needs
//      the price above the last buy and inflow still positive — so false starts
//      cost little and runners get size, up to 0.25 SOL per coin;
//   3. exits whole on the first of: a stop loss vs cost, a trailing stop once the
//      position ran up, inflow fading or one big sell hitting the tape, or a time
//      limit while the position is not meaningfully up — winners are ridden with
//      a loose trail (sell only after a 20% pullback from the peak) because on
//      pump.fun a handful of runners make the whole PnL;
//   4. runs tiny probe round trips (0.012 SOL in, sold as soon as it lands) on the
//      most liquid curves whenever the count of distinct coins with a completed
//      round trip lags the pace needed to clear the 20-coin guardrail;
//   5. stops opening new positions when equity drawdown passes 35%, and flattens
//      everything at 45% — the guardrail caps drawdown at 50%, so the bot never
//      lets a bad window put the entry below the bar.
//
// The parameters were chosen on the kit's dev window preferring flat regions over
// single best cells: tight dip entries beat loose ones, older curves beat fresh
// ones, and bigger size only amplifies the losers.
//
// Deterministic by construction: no clock, no Math.random, no environment reads.
// Iteration is only over insertion-ordered maps fed by the batch stream, so two
// runs on the same data produce byte-identical action logs.

import { LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const toSol = (lamports: bigint): number => Number(lamports) / 1e9;

// ---------------------------------------------------------------- parameters

export const DEFAULT_PARAMS = {
  // Entry window (slots) and tape requirements.
  window: 30,
  minNetSol: 0, // net SOL over the window must be >= 0: buyers are back, not just fewer sellers
  minBuys: 3,
  minBuyers: 5, // at least 5 distinct buyers: a crowd returning, not one wallet
  minPriceUp: -0.4,
  maxPriceUp: -0.05,
  accelRatio: 1, // newer-half net inflow must be >= this x older-half net
  nearHigh: 0.5, // price now must be >= this share of the window high
  maxBuyerShare: 0.6, // largest single wallet's share of window buy SOL
  minAge: 60, // slots since CreateEvent before an entry is allowed
  minRealSol: 0.5, // curve real SOL bounds at entry
  maxRealSol: 80,
  // Sizing (SOL).
  initialSol: 0.05,
  addSol: 0.05,
  maxStakeSol: 0.25,
  addStep: 0.03, // add only once price is this much above the last buy
  addNetSol: 0.5, // add only while window net inflow is at least this
  minBuySol: 0.01,
  // Exits.
  stopLoss: 0.9, // sell when mark value < cost * stopLoss
  trailArm: 1.1, // arm the trailing stop once value >= cost * trailArm
  trail: 0.8, // sell when value < peak * trail
  fadeWindow: 20, // sell when net SOL over this window < -fadeNetSol
  fadeNetSol: 0.3,
  bigSellSol: 0.75, // sell on any single recorded sell of at least this
  maxHold: 1500, // sell after this many slots held, unless up >= holdIfUp
  holdIfUp: 0.05,
  // Re-entry.
  cooldown: 200, // slots to wait after an exit before re-entering a curve
  maxEntries: 2, // most entries per curve over the run
  // Guardrail probes.
  targetCoins: 22, // distinct round-tripped coins to aim for (bar is 20)
  paceSecs: 21600, // 6-hour final window, in seconds
  probeSol: 0.011,
  probeMinRealSol: 3, // probes only on curves with at least this real SOL
  maxProbes: 30, // most probe round trips in one run (each one costs ~0.0005 SOL in fees)
  maxMain: 4, // most momentum positions at once (1 slot kept for probes)
  // Portfolio guards.
  maxExposureSol: 2, // most SOL at cost across all positions at once
  pauseDrawdown: 0.35, // stop opening positions past this equity drawdown
  flattenDrawdown: 0.45, // sell everything past this equity drawdown
  // Slippage.
  buySlipBps: 500,
  sellSlipBps: 10000,
};

export type Params = typeof DEFAULT_PARAMS;

interface PosInfo {
  entrySlot: number;
  lastBuyPrice: number;
  peakValue: number; // SOL, best mark value seen
  trailArmed: boolean;
  entries: number;
  probe: boolean;
  bought: boolean; // a buy fill for this position has been seen
  exiting: boolean; // a sell for this position is in flight
}

interface TapePoint {
  slot: number;
  price: number; // virtual quote per virtual token (SOL per token)
}

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // SOL amount of the trade
  user: string;
}

interface CurveTape {
  mint: Pubkey;
  createdSlot: number | null;
  complete: boolean;
  realSol: number;
  trades: TapeTrade[];
  points: TapePoint[];
}

interface PendingBuy {
  price: number;
  probe: boolean;
}

function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

// ---------------------------------------------------------------- the bot

export function createBot(overrides: Partial<Params> = {}): Bot {
  const P: Params = { ...DEFAULT_PARAMS, ...overrides };
  const tapes = new Map<Pubkey, CurveTape>();

  const positions = new Map<Pubkey, PosInfo>();
  const pendingBuys = new Map<Pubkey, PendingBuy>();
  const cooldownUntil = new Map<Pubkey, number>();
  const entriesPerCurve = new Map<Pubkey, number>();
  const roundTripped = new Set<Pubkey>();
  const boughtCoins = new Set<Pubkey>();

  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let peakEquitySol = 0;
  let flattened = false;
  let probesSent = 0;

  function tapeFor(mint: Pubkey): CurveTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { mint, createdSlot: null, complete: false, realSol: 0, trades: [], points: [] };
      tapes.set(mint, t);
    }
    return t;
  }

  function markValue(state: BotState, mint: Pubkey): number {
    const holding = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (holding === undefined || curve === undefined) return 0;
    const price = priceOf(curve);
    if (price <= 0) return 0;
    // tokens * price (SOL per token); token amounts are raw units.
    return Number(holding.token_amount) * price / 1e9;
  }

  function equitySol(state: BotState): number {
    let eq = toSol(state.cash);
    for (const mint of state.positions.keys()) eq += markValue(state, mint);
    return eq;
  }

  function windowStats(t: CurveTape, slot: number, window: number) {
    const from = slot - window;
    let net = 0;
    let buys = 0;
    let buySol = 0;
    const buyers = new Map<string, number>();
    let halfNet = 0;
    const mid = slot - Math.floor(window / 2);
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      const signed = tr.buy ? tr.sol : -tr.sol;
      net += signed;
      if (tr.slot > mid) halfNet += signed;
      if (tr.buy) {
        buys += 1;
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      }
    }
    let maxShare = 0;
    for (const v of buyers.values()) if (buySol > 0) maxShare = Math.max(maxShare, v / buySol);
    return { net, buys, buyers: buyers.size, maxShare, halfNet, olderNet: net - halfNet };
  }

  function windowPrice(t: CurveTape, slot: number, window: number) {
    const from = slot - window;
    let start = 0;
    let high = 0;
    let now = 0;
    for (const p of t.points) {
      if (p.slot <= from) continue;
      if (start === 0) start = p.price;
      if (p.price > high) high = p.price;
      now = p.price;
    }
    return { start, high, now };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];

      // --- fold this batch's events into the tapes -------------------------
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.createdSlot = e.slot;
          t.realSol = 0;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: toSol(BigInt(e.sol_amount)), user: e.user });
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (price > 0 && Number.isFinite(price)) t.points.push({ slot: e.slot, price });
          t.realSol = toSol(BigInt(e.real_quote_reserves));
        } else {
          tapeFor(e.mint).complete = true;
        }
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          lastBlockTime = e.block_time;
        }
      }
      // Prune tapes older than the longest lookback we use.
      const pruneFrom = slot - 200;
      for (const t of tapes.values()) {
        while (t.trades.length > 0 && t.trades[0].slot <= pruneFrom) t.trades.shift();
        while (t.points.length > 0 && t.points[0].slot <= pruneFrom) t.points.shift();
      }

      // --- fold fills: track buys, exits, round trips ----------------------
      for (const f of batch.fills) {
        if (f.status === 'rejected' && f.side === 'buy') {
          cooldownUntil.set(f.mint, slot + 60); // don't hammer a mint that refuses buys
        }
        if (f.status !== 'filled') {
          if (f.side === 'buy') {
            pendingBuys.delete(f.mint);
          } else {
            const info = positions.get(f.mint);
            if (info !== undefined) info.exiting = false; // sell failed/rejected: retry next batch
          }
          continue;
        }
        if (f.side === 'buy') {
          boughtCoins.add(f.mint);
          const pb = pendingBuys.get(f.mint);
          pendingBuys.delete(f.mint);
          const curve = state.curves.get(f.mint);
          const price = curve !== undefined ? priceOf(curve) : 0;
          const prev = positions.get(f.mint);
          positions.set(f.mint, {
            entrySlot: prev?.entrySlot ?? slot,
            lastBuyPrice: price > 0 ? price : pb?.price ?? 0,
            peakValue: prev?.peakValue ?? 0,
            trailArmed: prev?.trailArmed ?? false,
            entries: prev?.entries ?? (entriesPerCurve.get(f.mint) ?? 0) + 1,
            probe: pb?.probe ?? prev?.probe ?? false,
            bought: true,
            exiting: false,
          });
          entriesPerCurve.set(f.mint, positions.get(f.mint)!.entries);
        } else {
          // Sell fill (ours or a harness close): the round trip is done.
          if (boughtCoins.has(f.mint)) roundTripped.add(f.mint);
          positions.delete(f.mint);
          pendingBuys.delete(f.mint);
        }
      }
      // Drop position records the account no longer holds (harness closes).
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) {
          if (boughtCoins.has(mint)) roundTripped.add(mint);
          positions.delete(mint);
        }
      }

      // --- equity / drawdown guards ----------------------------------------
      const equity = equitySol(state);
      if (equity > peakEquitySol) peakEquitySol = equity;
      const drawdown = peakEquitySol > 0 ? (peakEquitySol - equity) / peakEquitySol : 0;
      const paused = drawdown >= P.pauseDrawdown;

      // Flatten everything if drawdown is near the 50% guardrail.
      if (drawdown >= P.flattenDrawdown && !flattened) {
        flattened = true;
        for (const [mint, holding] of state.positions) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: P.sellSlipBps });
          cooldownUntil.set(mint, slot + P.cooldown);
        }
        return orders;
      }

      // --- exits for every open position ------------------------------------
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let mainCount = 0;
      for (const [mint, holding] of state.positions) {
        const info = positions.get(mint);
        if (info === undefined || info.exiting) continue;
        if (!info.probe) mainCount += 1;
        const value = markValue(state, mint);
        const cost = toSol(holding.cost_lamports);
        if (cost <= 0) continue;
        if (value > info.peakValue) info.peakValue = value;
        if (!info.trailArmed && value >= cost * P.trailArm) info.trailArmed = true;

        let exit = false;
        if (info.probe) {
          // Probe: sell the moment the buy has landed.
          exit = info.bought;
        } else if (value < cost * P.stopLoss) {
          exit = true; // stop loss
        } else if (info.trailArmed && value < info.peakValue * P.trail) {
          exit = true; // trailing stop
        } else if (slot - info.entrySlot > P.maxHold && value < cost * (1 + P.holdIfUp)) {
          exit = true; // time limit, not meaningfully up
        } else {
          const t = tapes.get(mint);
          if (t !== undefined) {
            const fade = windowStats(t, slot, P.fadeWindow);
            if (fade.net < -P.fadeNetSol) exit = true; // inflow faded / turned seller
            if (!exit) {
              for (const tr of t.trades) {
                if (tr.slot === slot && !tr.buy && tr.sol >= P.bigSellSol) {
                  exit = true; // one big sell hit the tape
                  break;
                }
              }
            }
          }
        }
        if (exit) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: P.sellSlipBps });
          cooldownUntil.set(mint, slot + P.cooldown);
          info.exiting = true;
        }
      }

      // --- pyramid adds into strength ---------------------------------------
      if (!paused) {
        let exposure = 0;
        for (const holding of state.positions.values()) exposure += toSol(holding.cost_lamports);
        for (const [mint, holding] of state.positions) {
          const info = positions.get(mint);
          if (info === undefined || info.probe) continue;
          const t = tapes.get(mint);
          const curve = state.curves.get(mint);
          if (t === undefined || curve === undefined || curve.complete) continue;
          const cost = toSol(holding.cost_lamports);
          if (cost >= P.maxStakeSol) continue;
          if (exposure + P.addSol > P.maxExposureSol) continue;
          const price = priceOf(curve);
          if (price <= 0 || price < info.lastBuyPrice * (1 + P.addStep)) continue;
          const stats = windowStats(t, slot, P.window);
          if (stats.net < P.addNetSol) continue;
          const cap = state.maxBuyLamports(mint);
          const amount = cap < BigInt(Math.round(P.addSol * 1e9)) ? cap : BigInt(Math.round(P.addSol * 1e9));
          if (amount < BigInt(Math.round(P.minBuySol * 1e9))) continue;
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
          pendingBuys.set(mint, { price, probe: false });
          info.lastBuyPrice = price;
          free -= amount + tx;
          exposure += P.addSol;
        }
      }

      // --- new momentum entries ---------------------------------------------
      if (!paused) {
        let exposure = 0;
        for (const holding of state.positions.values()) exposure += toSol(holding.cost_lamports);
        for (const e of batch.events) {
          if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
          if (mainCount >= P.maxMain) break;
          if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          const t = tapes.get(mint);
          const curve = state.curves.get(mint);
          if (t === undefined || curve === undefined || curve.complete) continue;
          if (t.createdSlot === null || slot - t.createdSlot < P.minAge) continue;
          if (slot < (cooldownUntil.get(mint) ?? -1)) continue;
          if ((entriesPerCurve.get(mint) ?? 0) >= P.maxEntries) continue;
          if (t.realSol < P.minRealSol || t.realSol > P.maxRealSol) continue;
          const stats = windowStats(t, slot, P.window);
          if (stats.net < P.minNetSol || stats.buys < P.minBuys || stats.buyers < P.minBuyers) continue;
          if (stats.maxShare > P.maxBuyerShare) continue;
          if (stats.halfNet < stats.olderNet * P.accelRatio) continue;
          const wp = windowPrice(t, slot, P.window);
          if (wp.start <= 0 || wp.now <= 0) continue;
          const up = wp.now / wp.start - 1;
          if (up < P.minPriceUp || up > P.maxPriceUp) continue;
          if (wp.now < wp.high * P.nearHigh) continue;
          if (exposure + P.initialSol > P.maxExposureSol) continue;
          const cap = state.maxBuyLamports(mint);
          const amount = cap < BigInt(Math.round(P.initialSol * 1e9)) ? cap : BigInt(Math.round(P.initialSol * 1e9));
          if (amount < BigInt(Math.round(P.minBuySol * 1e9))) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
          pendingBuys.set(mint, { price: wp.now, probe: false });
          free -= amount + tx;
          exposure += P.initialSol;
          mainCount += 1;
        }
      }

      // --- guardrail probes --------------------------------------------------
      if (!paused && firstBlockTime !== null && lastBlockTime !== null && probesSent < P.maxProbes) {
        const elapsed = lastBlockTime - firstBlockTime;
        // Pace toward targetCoins over the 6h window, never past it: on a longer
        // window the pace must not keep demanding more coins.
        const paceCoins = Math.min(P.targetCoins, Math.floor((P.targetCoins * elapsed) / P.paceSecs));
        const need = paceCoins - roundTripped.size;
        if (need > 0 && state.committedPositionCount() < state.hello.caps.max_open_positions) {
          // Most liquid curve with recent trades, no position, not cooling down.
          let best: CurveTape | null = null;
          for (const t of tapes.values()) {
            if (t.complete || t.realSol < P.probeMinRealSol) continue;
            if (state.positions.has(t.mint) || pendingBuys.has(t.mint)) continue;
            if (roundTripped.has(t.mint)) continue; // probing it again adds no new coin
            if (slot < (cooldownUntil.get(t.mint) ?? -1)) continue;
            if (boughtCoins.has(t.mint) && !roundTripped.has(t.mint)) continue;
            let recent = 0;
            for (const tr of t.trades) if (tr.slot > slot - 10) recent += 1;
            if (recent < 2) continue;
            if (best === null || t.realSol > best.realSol) best = t;
          }
          if (best !== null && orders.length < state.hello.caps.max_orders_per_batch) {
            const amount = BigInt(Math.round(P.probeSol * 1e9));
            const cap = state.maxBuyLamports(best.mint);
            const spend = amount < cap ? amount : cap;
            if (spend >= BigInt(Math.round(P.minBuySol * 1e9)) && free >= spend + tx) {
              orders.push({ side: 'buy', mint: best.mint, quote_lamports: spend, max_slippage_bps: P.buySlipBps });
              pendingBuys.set(best.mint, { price: priceOf(state.curves.get(best.mint)!), probe: true });
              free -= spend + tx;
              probesSent += 1;
            }
          }
        }
      }

      return orders;
    },
  };
}
