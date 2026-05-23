# IBKR BTC Futures Bot — Strategy Concept

**Author:** Working notes for Tanner
**Date:** 2026-05-19
**Status:** Concept only — not implementation. Validation comes before code.

---

## 1. Reality Check — Why "600%/month" is off the table

| Target | Compounded yearly | Real-world reference |
|---|---|---|
| 600% / month | ~10,000,000% / yr | Has never existed in any track record |
| 50% / month | ~13,000% / yr | Sustained: 0 funds. Briefly: scam-adjacent |
| 20% / month | ~792% / yr | Top-decile prop trader, rare |
| **10% / month** | **~213% / yr** | **Excellent — top hedge funds** |
| 5% / month | ~80% / yr | Very good systematic trader |
| 2-3% / month | ~27-43% / yr | Realistic ambitious target |

Any concept that claims 600%/month is either (a) overfit backtest, (b) hidden leverage that will blow up, or (c) lying. We're going to design for **5-12% / month with controlled drawdowns**, because that's the upper bound of what's actually achievable on BTC futures with a real edge. Compounding 8%/month is 151% per year — life-changing if it holds.

## 2. The Real Lesson from the Kalshi Bot

The Kalshi bot's edge isn't "RSI." RSI is the *trigger*. The actual edge comes from four things stacked:

1. **Binary payoff** — you get paid for being directionally right at a fixed moment (expiry). No drawdown risk along the way.
2. **Favored-side selection** — buying YES at 65-85¢ on momentum confirms a high-prob outcome with bounded loss.
3. **Multi-strategy stacking** — sports + econ + crypto + news, each uncorrelated, smoothing equity curve.
4. **Kelly sizing on binaries** — well-defined p/q probabilities → mathematically optimal bet sizing.

**None of those translate directly to BTC futures.** Futures:
- Have no expiry crystallization within a useful timeframe
- Have unbounded loss until your stop hits (and stops slip)
- Are one asset, not a diversified market portfolio
- Have noisy/unknowable "true probability" — you can't compute Kelly p without that

So we have to build a *different* edge for futures. The Kalshi mental model doesn't port.

## 3. What BTC Futures Actually Reward

From the 30-day backtest data sitting in `backtest_data/binance_BTCUSDT_30d.csv` and standard literature on BTC microstructure, edges that have held up historically:

### a) Volatility-Regime Trend Following
BTC trends strongly when realized volatility is *expanding* and chops when vol is *compressed*. RSI mean-reversion (current bot) is fighting the trend in the regime where momentum works best. **Inversion: trade momentum when ATR is rising, mean-reversion only when ATR is falling.**

### b) Funding Rate / Basis as a Sentiment Filter
Perpetual funding rate and futures basis tell you when crypto is one-sided. Extreme positive funding = longs overleveraged, mean-reversion short edge. Extreme negative funding = shorts squeezed, momentum long edge. CME front-month basis vs spot is the cleanest signal — IBKR gives you both prices.

### c) Session Effects
BTC has distinctly different behavior in three sessions:
- **Asia (00-08 UTC):** range-bound, mean-reversion friendlier
- **Europe (08-13 UTC):** trend initiation
- **US (13-22 UTC):** continuation or reversal — highest realized vol, biggest opportunity *and* risk

Time-of-day is a free feature. Most retail bots ignore it.

### d) Liquidation Cascades
Big stop runs leave a measurable footprint: a spike in volume + a wick beyond a recent swing high/low that closes back inside. These are very-short-term reversal setups (15-60 min hold). The Kalshi bot's "capitulation bounce" logic is groping at this; on futures it's executable.

### e) Cross-Asset Correlation Breaks
When BTC and Nasdaq diverge intraday (one up >1%, the other down >1%), one of them usually catches up within hours. Mean-reversion on the divergence is a known edge, especially overnight when crypto trades alone.

## 4. Proposed Strategy Concept — "Regime-Adaptive Momentum + Mean-Reversion"

Single instrument: **MBT (BTC Micro Futures, CME)**. 0.1 BTC per contract. Margin ~$1,500-2,000.

### Core architecture

```
┌─────────────────────────────────────────────────────────────┐
│  REGIME DETECTOR (runs every bar)                           │
│   - ATR(14) percentile rank over last 30 days               │
│   - 50/200 EMA slope direction                              │
│   - Realized vol regime: HIGH / NORMAL / LOW                │
│   - Trend regime: TRENDING / RANGING                        │
└─────────────────────────────────────────────────────────────┘
           │                            │
           ▼                            ▼
  TRENDING + HIGH VOL          RANGING + LOW/NORMAL VOL
  → Momentum module             → Mean-reversion module
  (breakouts, MA pullback)      (RSI / Bollinger band fades)
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│  CONFIRMATION FILTERS (must all pass to enter)              │
│   - Session filter (only trade preferred sessions)          │
│   - Funding/basis bias (don't fade extreme one-sidedness)   │
│   - Volume confirm (entry bar > avg vol)                    │
│   - Spread check (skip if bid/ask > 0.05% mid)              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  POSITION SIZING                                            │
│   - Volatility-adjusted: position size scales 1/ATR         │
│   - Fractional Kelly (max 0.15 of theoretical Kelly)        │
│   - Hard cap: 20% of equity in margin per trade             │
│   - Single position at a time (no pyramiding initially)     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  EXITS                                                      │
│   - Initial stop: 1.5× ATR from entry                       │
│   - Trailing stop after 1×ATR profit: locks in breakeven    │
│   - Time stop: close after 6 hours regardless               │
│   - Hard kill: -3% equity day → flat + halt 24h             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  CIRCUIT BREAKERS                                           │
│   - 3 losses in a row → pause 6 hours                       │
│   - Daily loss limit -3% → halt for the day                 │
│   - Weekly drawdown -7% → halt, require manual restart      │
│   - Equity below 50% of starting → permanent halt           │
└─────────────────────────────────────────────────────────────┘
```

### Why this is different from the current bot

| Current bot | This concept |
|---|---|
| Pure RSI 27/77 mean-reversion in all regimes | Regime-switched: momentum in trends, MR in ranges |
| RSI thresholds too extreme — fires 0 BTC trades in 30d | Adaptive thresholds tied to vol regime |
| Fixed 8% Kelly | Vol-adjusted sizing — small in chop, full in clean trends |
| Time exit only (1 hour) | ATR-based stops + trailing + time exit |
| No regime detection | Regime is the first decision |
| No daily/weekly kill switches | Multi-layer circuit breakers |
| No session/funding filters | Both used as gating filters |

## 5. Realistic Return Expectations

Math on what 5-12%/month requires on MBT:

- **Per-contract notional:** ~$10,000 (0.1 BTC × ~$100k)
- **Average trade move (1.5× ATR target):** ~1.2% on BTC = ~$120 per contract
- **Win rate target:** 50-55% (this is achievable; >60% sustained is overfitting)
- **Win/loss ratio target:** 1.4-1.8× (asymmetric — let winners run, cut losers fast)
- **Expected value per trade:** ~0.25-0.4% of capital with proper sizing
- **Trade frequency:** 8-20 trades / month after filters
- **Compounded:** 2-8% / month base case, 8-15% in favorable regimes

This is what a *real* systematic BTC futures strategy looks like. Anything claiming more is either levered to the gills or fitting the past.

## 6. Why Your Current $50 Capital Is a Constraint

MBT margin is ~$1,750/contract. On $50, you literally can't take a single contract — you'd be wiped out by one tick of margin. To trade MBT seriously you need **at least $5,000** so a single contract is <35% of margin and you have room for stops + drawdown. With your current $50 on IBKR, the only viable BTC instrument is **fractional spot BTC via PAXOS** (which your config already supports), not MBT futures.

Recommendation: **paper-trade MBT** until you have $5k+, and trade fractional BTC spot on $50 with this same strategy. The strategy logic is identical; only the position-size math changes.

## 7. Validation Plan (Before Touching Live Money)

This is non-negotiable.

### Phase 1 — Backtest with proper rigor (2-4 weeks)
1. **Walk-forward optimization:** train on months 1-12, test on month 13, slide forward. No peeking.
2. **Out-of-sample test:** never tune parameters on the test window
3. **Transaction costs:** assume 2 ticks slippage + commission (~$0.85 round-trip on MBT)
4. **Multiple market regimes:** must show positive expectancy in bull (2024 Q1), bear (2022), and chop (2023 Q3) periods *separately*
5. **Monte Carlo on trade sequence:** reshuffle trade order 10,000× — what's the 5th percentile drawdown? If it's >25%, the strategy is too risky regardless of average return
6. **Pass criteria:**
   - Sharpe > 1.2 (after costs)
   - Profit factor > 1.4
   - Max DD < 20%
   - Positive in at least 8/12 months out-of-sample
   - Trade count > 50 per regime tested

### Phase 2 — Paper trading (4-8 weeks)
- Run the bot live on IBKR paper account
- Compare paper P&L to backtest predicted P&L for the same period
- If they diverge by >2σ, something is wrong (slippage assumption, signal latency, etc.)
- Continue until you have 30+ closed trades in paper

### Phase 3 — Live, minimum size (4-8 weeks)
- One contract max, regardless of Kelly suggestion
- Compare live to paper — execution quality, slippage, fill rates
- If live underperforms paper by >25%, halt and investigate

### Phase 4 — Scale up
- Only after Phase 3 shows live ≈ paper ≈ backtest
- Scale position size in 25% increments, watching for capacity issues

## 8. Concrete Next Steps

1. **Don't touch the live IBKR bot** until we've built and validated the strategy in this doc.
2. **Build the regime detector first** as a standalone module — backtest just the regime classification and verify it correlates with the actual market state.
3. **Then layer in the momentum and mean-reversion sub-strategies** as separate modules, backtest each on its own.
4. **Only then combine them** with the gating filters. Each addition must improve the backtest, not just maintain it.
5. **Build a proper backtest harness** with the rigor in Section 7. The current `ibkr_backtest.py` is a good starting point but needs walk-forward + Monte Carlo + cost modeling added.

## 9. What I'm Asking You to Accept

- **The 600%/month target gets retired.** If you keep aiming there, you'll force the bot into ruinous leverage and lose your account. I won't build that.
- **The Kalshi 7/7 doesn't transfer.** Different instrument, different math, different edge.
- **Validation comes before live trading.** Months, not days. This is the single biggest separator between traders who survive and traders who don't.
- **Real target: 3-10% / month average, with months that lose money.** Even great strategies have losing months. A bot that "never loses" is fraud or unsampled.

If you're good with this framing, the next conversation is: do you want to start by upgrading the backtest harness, or building the regime detector? Those are the first two real pieces of code.
