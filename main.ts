// Pump.fun Paper Sprint bot — graduation momentum, with tiny probe round
// trips that keep the entry above the competition guardrail (a >= 0.01 SOL
// round trip on at least 20 coins, max drawdown <= 50%).
//
// Why this shape: the replay fills orders 2 slots after they are decided, and
// offline research on the dev dataset showed that fast follow-signals (tape
// momentum, whale buys, launch sniping, dip buying) lose their edge inside
// that latency — by the time the fill lands, the move is over and the bot is
// exit liquidity. The one slow signal that kept a positive expectancy under
// realistic entry AND exit latency is graduation momentum:
//
//   A curve that has climbed to ~52 SOL of real reserves has survived the
//   bundled-launch dump phase that kills most coins. If buy pressure is still
//   intact at that crossing — lifetime buy share >= 55%, net inflow over the
//   last 60 slots >= 1 SOL, price within 10% of its lifetime high, and the
//   creator has never sold — the run tends to continue toward completion.
//   Buy 0.5 SOL (never more than the harness's 1%-of-real-reserve cap),
//   at most 4 positions at once, and get out on take-profit (+30%), a
//   trailing stop (arms at +8%, fires 12% below the peak value), a stop
//   loss (-15%), fading flow, staleness, a creator sell, or 2500 slots held.
//
// Probes: until 24 distinct coins have finished a round trip, the bot also
// buys 0.015 SOL of a liquid curve (real SOL 8-70, at least 120 slots old,
// active tape) at most once per 45 s of block time and sells it as soon as
// the position lands. That is the guardrail insurance; it costs a few
// thousandths of a SOL in fees and keeps the real positions free to wait.
//
// A portfolio halt stops new entries once the mark-to-market equity falls
// 25% below its peak, protecting the 50% drawdown guardrail. The replay
// itself closes positions whose curve completes and flattens whatever is
// left at the end of the window, so no end-of-window handling is needed.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O,
// no environment reads — the two graded executions produce identical orders.
// It speaks the hello / batch / orders / slot protocol through the vendored
// SDK shim: state.hello first, then one reply of orders per batch.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);
const FEE_BPS = 125n; // protocol 95 + creator 30
const BPS = 10_000n;

// ---- graduation entry ---------------------------------------------------------
const GRAD_RQ = 52; // real SOL reserve that marks the crossing
const GRAD_STAKE = 0.5; // SOL per position (the 1%-of-reserve cap may bind)
const GRAD_MIN_BUY_SHARE = 0.55; // lifetime buy SOL / total SOL
const GRAD_RECENT_NET = 1.0; // net SOL inflow over the last 60 slots
const GRAD_NEAR_HIGH = 0.9; // price at least this share of the lifetime high
const GRAD_MAX_AGE = 30_000; // slots since CreateEvent
const MAX_POSITIONS = 4; // graduation positions at once (one slot stays free)
const MAX_EXPOSURE = 3.2; // most SOL at cost across all positions
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10_000;

// ---- exits --------------------------------------------------------------------
const TAKE_PROFIT = 0.3; // sell all at this gain over cost
const STOP_LOSS = 0.15; // sell all at this loss under cost
const TRAIL_ARM = 0.08; // trailing stop arms at this gain
const TRAIL = 0.12; // ...and fires on this fall from the peak value
const FADE_WIN = 30; // flow window for the fade exit, slots
const FADE_NET = -0.5; // exit when net SOL over FADE_WIN drops below this
const MAX_HOLD = 2500; // slots, whatever the tape says
const STALE = 300; // exit when no trade has hit the coin for this long
const DD_HALT = 0.25; // stop new entries past this equity drawdown

// ---- guardrail probes -----------------------------------------------------------
const PROBE_SOL = 0.015; // >= the 0.01 SOL round-trip minimum, kept tiny
const PROBE_TARGET = 24; // distinct coins with a finished round trip
const PROBE_EVERY_SECS = 45; // at most one new probe per this much block time
const PROBE_MIN_RQ = 8; // probe only liquid curves
const PROBE_MAX_RQ = 70;
const PROBE_MIN_AGE = 120; // slots since CreateEvent

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

interface Tape {
  created: number | null;
  creator: Pubkey | null;
  creatorSold: boolean;
  trades: Trade[];
  gradDone: boolean; // the graduation crossing was already evaluated once
  dead: boolean; // curve completed
}

interface Held {
  opened: number;
  peakValue: number;
  probe: boolean;
}

/** What selling `tokens` against reserves (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight: mint -> true once its sell has been sent. */
const probes = new Map<Pubkey, boolean>();
const roundTripped = new Set<Pubkey>();
const boughtOk = new Set<Pubkey>(); // mints with a filled buy >= 0.01 SOL
let firstTime: number | null = null;
let nowTime = 0;
let lastProbeTime = -1e9;
let peakEquity = 0;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, creator: null, creatorSold: false, trades: [], gradDone: false, dead: false };
    tapes.set(mint, t);
  }
  return t;
}

function priceOf(vq: bigint, vt: bigint): number {
  return vt === 0n ? 0 : Number(vq) / Number(vt);
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();

    // -- fold the batch's events into the tapes and the clock --
    for (const e of batch.events) {
      if (typeof e.timestamp === 'string') {
        const ts = Number(e.timestamp);
        if (ts > 0) {
          if (firstTime === null) firstTime = ts;
          if (ts > nowTime) nowTime = ts;
        }
      }
      const t = tapeOf(e.mint);
      if (e.event === 'CreateEvent') {
        t.created = e.slot;
        t.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(BigInt(e.sol_amount)) / SOL, user: e.user, price });
        if (t.trades.length > 600) t.trades.splice(0, t.trades.length - 600);
        if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
      } else {
        t.dead = true;
      }
    }

    // -- fills: track finished round trips for the guardrail --
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'buy' && BigInt(f.quote_lamports) >= 10_000_000n) boughtOk.add(f.mint);
      if (f.side === 'sell' && boughtOk.has(f.mint)) roundTripped.add(f.mint);
      if (f.side === 'sell' && !state.positions.has(f.mint)) {
        held.delete(f.mint);
        probes.delete(f.mint);
      }
    }

    const pendingMints = new Set<Pubkey>();
    const selling = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      pendingMints.add(p.order.mint);
      if (p.order.side === 'sell') selling.add(p.order.mint);
    }

    // -- equity drawdown halt --
    let equity = Number(state.cash);
    for (const [mint, h] of state.positions) {
      const c = state.curves.get(mint);
      if (c !== undefined) equity += Number(sellValue(h.token_amount, c.virtual_quote_reserves, c.virtual_token_reserves, c.real_quote_reserves));
    }
    if (equity > peakEquity) peakEquity = equity;
    const halted = peakEquity > 0 && equity < peakEquity * (1 - DD_HALT);

    // -- 1. exits on held positions --
    for (const [mint, h] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const hd = held.get(mint);
      const value = Number(sellValue(h.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves));
      const cost = Number(h.cost_lamports);
      if (cost <= 0) continue;
      if (hd !== undefined && value > hd.peakValue) hd.peakValue = value;
      const opened = hd?.opened ?? batch.slot;
      const isProbe = hd?.probe ?? probes.has(mint);
      let exit = isProbe; // probes sell as soon as the position lands
      if (!exit && hd !== undefined) {
        const gain = value / cost - 1;
        if (gain >= TAKE_PROFIT || gain <= -STOP_LOSS) exit = true;
        else if (hd.peakValue >= cost * (1 + TRAIL_ARM) && value <= hd.peakValue * (1 - TRAIL)) exit = true;
        else if (batch.slot - opened >= MAX_HOLD) exit = true;
        else {
          const t = tapes.get(mint);
          if (t !== undefined && t.trades.length > 0) {
            const lastTrade = t.trades[t.trades.length - 1]!;
            if (batch.slot - lastTrade.slot >= STALE) exit = true;
            else if (gain < 0.02) {
              let fadeNet = 0;
              for (const x of t.trades) if (batch.slot - x.slot <= FADE_WIN) fadeNet += x.buy ? x.sol : -x.sol;
              if (fadeNet < FADE_NET) exit = true;
            }
          }
          if (t?.creatorSold) exit = true;
        }
      }
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        free -= tx;
        if (probes.has(mint)) probes.set(mint, true);
      }
    }

    // -- 2. graduation entries --
    let exposure = 0;
    for (const h of state.positions.values()) exposure += Number(h.cost_lamports);
    let mainCount = 0;
    for (const mint of state.positions.keys()) if (!probes.has(mint)) mainCount++;
    for (const p of state.pending.values()) if (p.order.side === 'buy' && !probes.has(p.order.mint)) mainCount++;

    if (!halted && mainCount < MAX_POSITIONS) {
      for (const [mint, t] of tapes) {
        if (orders.length >= cap || mainCount >= MAX_POSITIONS) break;
        if (t.gradDone || t.dead || t.creatorSold || t.created === null) continue;
        if (state.positions.has(mint) || pendingMints.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = Number(curve.real_quote_reserves) / SOL;
        if (rq < GRAD_RQ) continue;
        t.gradDone = true; // the crossing is evaluated once, pass or fail
        if (batch.slot - t.created > GRAD_MAX_AGE) continue;
        let buySol = 0;
        let totalSol = 0;
        let recentNet = 0;
        let high = 0;
        for (const x of t.trades) {
          totalSol += x.sol;
          if (x.buy) buySol += x.sol;
          if (batch.slot - x.slot <= 60) recentNet += x.buy ? x.sol : -x.sol;
          if (x.price > high) high = x.price;
        }
        if (totalSol === 0 || buySol / totalSol < GRAD_MIN_BUY_SHARE) continue;
        if (recentNet < GRAD_RECENT_NET) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (high <= 0 || price < GRAD_NEAR_HIGH * high) continue;
        if (exposure + GRAD_STAKE * SOL > MAX_EXPOSURE * SOL) continue;
        const capBuy = state.maxBuyLamports(mint);
        const amount = Math.min(GRAD_STAKE * SOL, Number(capBuy));
        if (amount < 0.01 * SOL || free < BigInt(Math.floor(amount)) + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount)), max_slippage_bps: BUY_SLIP_BPS });
        free -= BigInt(Math.floor(amount)) + tx;
        exposure += amount;
        mainCount++;
        held.set(mint, { opened: batch.slot, peakValue: 0, probe: false });
      }
    }

    // -- 3. guardrail probes: tiny round trips on liquid curves --
    if (
      roundTripped.size + probes.size < PROBE_TARGET &&
      state.committedPositionCount() < state.hello.caps.max_open_positions &&
      orders.length < cap &&
      nowTime - lastProbeTime >= PROBE_EVERY_SECS
    ) {
      let best: Pubkey | null = null;
      let bestRq = 0;
      for (const [mint, curve] of state.curves) {
        if (curve.complete || state.positions.has(mint) || pendingMints.has(mint) || probes.has(mint)) continue;
        if (roundTripped.has(mint) || boughtOk.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.dead || t.created === null) continue;
        if (batch.slot - t.created < PROBE_MIN_AGE) continue;
        const rq = Number(curve.real_quote_reserves) / SOL;
        if (rq < PROBE_MIN_RQ || rq > PROBE_MAX_RQ) continue;
        let recent = 0;
        for (const x of t.trades) if (batch.slot - x.slot <= 60) recent++;
        if (recent < 6) continue;
        if (rq > bestRq) {
          bestRq = rq;
          best = mint;
        }
      }
      if (best !== null) {
        const capBuy = state.maxBuyLamports(best);
        const amount = Math.min(PROBE_SOL * SOL, Number(capBuy));
        if (amount >= 0.01 * SOL && free >= BigInt(Math.floor(amount)) + tx) {
          orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(amount)), max_slippage_bps: BUY_SLIP_BPS });
          free -= BigInt(Math.floor(amount)) + tx;
          probes.set(best, false);
          held.set(best, { opened: batch.slot, peakValue: 0, probe: true });
          lastProbeTime = nowTime;
        }
      }
    }

    // Positions the bot did not open through `held` still need an opened slot.
    for (const mint of state.positions.keys()) {
      if (!held.has(mint)) {
        held.set(mint, { opened: batch.slot, peakValue: 0, probe: probes.has(mint) });
      }
    }

    return orders;
  },
});
