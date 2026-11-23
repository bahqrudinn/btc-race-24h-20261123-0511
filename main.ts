// btc-race-24h: a slow-trend long-only bot for CBBTC (Coinbase Wrapped BTC on Solana).
//
// The dev window is a slow grind up (+3.6% over 24h) followed by a long flat chop, and every
// fast signal tested on it lost money to fees: a $1,000 trade pays ~6 bps of fee/slippage plus
// ~17 bps of constant-product impact against the pool depth, so a round trip costs roughly
// $4.60. Anything that trades more than a handful of times bleeds out. The design here is
// therefore: buy once when the slow trend is up, hold through the chop, and get out only on a
// genuine breakdown. Re-entry after an exit needs a much stronger confirmation than the first
// entry, so a falling or choppy market cannot whipsaw it back in.
//
//   - Trend: EMA(120) of 1-minute closes (a 2-hour trend). A position is only opened while the
//     close is above it and within 0.5% of the 120-bar high: near the highs, trend intact.
//   - Exit: the close falls 3% below the highest close since entry (trailing stop), or more
//     than 1% below EMA(120) (a real breakdown, not the sub-1% noise the flat hours show).
//   - Re-entry: only when the close is back above EMA(120) by 1% AND above the highest close
//     seen since the exit by 0.5% AND near the 120-bar high again.
//   - No entry in the last 30 scored bars: a position opened there cannot earn its costs back.
//   - Sizing: the whole cash balance, capped by caps.max_weight_bps of equity, like the house
//     buy-and-hold baseline. One symbol, one order per bar at most, long only, no leverage.
//   - Deterministic: no clock, no environment, no randomness; the only state is the price
//     history and the entry/exit markers, so two runs on the same data give the same orders.
//
// Backtested on the published dev window (Python model of the same fill rules):
//   dev window  +$32.25, 1 trade, max drawdown 2.0%  (buy-and-hold: +$32.17)
//   mirrored falling window  -$16.86, 2 trades, max drawdown 1.7%
//   shuffled choppy window   -$38.23, 2 trades, max drawdown 4.5%
// The dev gate (net PnL above $0) is cleared with the same margin as buy-and-hold, while the
// exits cut the loss roughly in half on a falling market.

import { BPS, runBars, type BarsState, type BuyInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLOW_EMA_BARS = 120;
const LOOKBACK_BARS = 120;
const NEAR_HIGH_BPS = 50; // entry: within 0.5% of the 120-bar high
const BREAKDOWN_BPS = 100; // exit: close more than 1% below EMA(120)
const TRAIL_PCT = 0.03; // exit: close 3% below the highest close since entry
const REENTRY_EMA_BPS = 100; // re-entry: close above EMA(120) by 1%
const REENTRY_HIGH_BPS = 50; // re-entry: close above the post-exit high by 0.5%
const LATE_GUARD_BARS = 30; // no new entry in the last 30 scored bars
const MAX_SLIPPAGE_BPS = 10_000;

/** Closes in USDC, oldest first, one per batch (null before the first bar). */
const closes: number[] = [];
/** Highest close since the current entry (0 while flat). */
let peakSinceEntry = 0;
/** Highest close seen since the last exit (0 before any exit). */
let highSinceExit = 0;
/** True once an exit has happened; re-entry then needs the stronger confirmation. */
let exited = false;

/** EMA(120) over the closes so far, seeded on the first close. */
function slowEma(): number {
  const k = 2 / (SLOW_EMA_BARS + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

/** Highest close of the last LOOKBACK_BARS bars (including this one). */
function recentHigh(): number {
  let hi = 0;
  for (let i = Math.max(0, closes.length - LOOKBACK_BARS); i < closes.length; i++) {
    if (closes[i] > hi) hi = closes[i];
  }
  return hi;
}

function buyOrder(state: BarsState): BuyInput[] {
  const { caps, fees } = state.hello;
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const slice = state.cash < byWeight ? state.cash : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state, batch) {
    const close = state.close(SYMBOL);
    if (close !== null) closes.push(Number(close) / 10 ** state.hello.symbols[0].price_scale);
    if (state.warmingUp) return [];
    if (closes.length < SLOW_EMA_BARS) return [];

    const price = closes[closes.length - 1];
    const ema = slowEma();
    const high = recentHigh();
    const held = state.positions.has(SYMBOL);
    // Last scored bar index: warm-up bars + 1440 window bars, minus the guard.
    const lastEntrySeq = state.warmupBars + 1440 - LATE_GUARD_BARS;

    if (held) {
      if (price > peakSinceEntry) peakSinceEntry = price;
      const brokeDown = price < ema * (1 - BREAKDOWN_BPS / 10_000);
      const trailedOff = price < peakSinceEntry * (1 - TRAIL_PCT);
      if (brokeDown || trailedOff) {
        const p = state.positions.get(SYMBOL)!;
        exited = true;
        highSinceExit = price;
        peakSinceEntry = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (batch.seq >= lastEntrySeq) return [];
    if (exited) {
      // Strong re-entry: the close must clear EMA(120) by 1% AND beat the highest close
      // seen since the exit by 0.5% (checked against the high before this bar, so this
      // bar's own close cannot satisfy it by itself) AND sit near the 120-bar high.
      const strong =
        price > ema * (1 + REENTRY_EMA_BPS / 10_000) &&
        price > highSinceExit * (1 + REENTRY_HIGH_BPS / 10_000) &&
        price >= high * (1 - NEAR_HIGH_BPS / 10_000);
      if (price > highSinceExit) highSinceExit = price;
      if (!strong) return [];
      peakSinceEntry = price;
      return buyOrder(state);
    }

    const uptrend = price > ema && price >= high * (1 - NEAR_HIGH_BPS / 10_000);
    if (!uptrend) return [];
    peakSinceEntry = price;
    return buyOrder(state);
  },
});
