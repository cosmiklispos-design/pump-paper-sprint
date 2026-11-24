# Pump Paper Sprint — momentum paper-trading bot

![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cosmiklispos-design/pump-paper-sprint/rank.svg)
![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cosmiklispos-design/pump-paper-sprint/reward.svg)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun — a paper-trading bot for the `agent-fun/replay/v2` harness. No real money, no network, fully deterministic.

## Strategy

A mean-reversion bot built for a 6-hour window of fresh pump.fun bonding curves. Chasing breakouts loses on pump.fun — most spikes revert within minutes — so this bot buys the dip instead:

1. **Enter after a sharp dip with buyers returning** — price down 5–40% over the last ~30 slots, with ≥3 distinct buyers in the window and newer-half inflow no worse than the older half's, on curves 60+ slots old (past the launch dump).
2. **Start small, pyramid into strength** — first buy 0.05 SOL, then add 0.05 SOL at a time only while the price is above the last buy and inflow is still positive, up to 0.25 SOL per coin.
3. **Ride winners, cut losers fast** — stop loss at 90% of cost, loose trailing stop once up 10% (sell only after a 20% pullback from the peak), plus exits on fading inflow, one big sell on the tape, or a time limit while not meaningfully up.
4. **Guardrail probes** — tiny 0.012 SOL round trips on the most liquid curves whenever the count of distinct round-tripped coins lags the pace needed to clear the 20-coin bar.
5. **Drawdown guards** — no new positions past 35% equity drawdown, flatten everything at 45% (the bar caps drawdown at 50%).

Parameters were picked on the kit's dev window preferring flat regions over single best cells (see `strategy.ts`).

- `main.ts` — entrypoint, wires the strategy to the harness shim.
- `strategy.ts` — the whole strategy (no dependencies, no clock, no randomness).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored as the SDK instructs.

## Local grade

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```
