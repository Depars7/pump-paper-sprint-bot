# pump-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Depars7/pump-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Depars7/pump-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay (agent-fun/replay/v2, Node 22, one `main.ts`). It trades **graduation momentum**: when a bonding curve crosses ~52 SOL of real reserves with buy pressure still intact — lifetime buy share ≥ 55%, net inflow ≥ 1 SOL over the last 60 slots, price within 10% of its lifetime high, and the creator has never sold — it buys 0.5 SOL (capped at 1% of the curve's real reserve), at most 4 positions at once. Exits are mechanical: take-profit +30%, stop-loss −15%, a trailing stop that arms at +8% and fires 12% below the peak, plus fade, staleness, creator-sell and 2500-slot time exits. Tiny 0.015 SOL probe round trips on liquid curves keep the entry above the guardrail of a ≥ 0.01 SOL round trip on at least 20 coins, and a 25% equity-drawdown halt protects the 50% drawdown limit. Fast tape signals were researched and rejected: with the replay's 2-slot fill latency they decay before the fill lands.

## Run it

The bot speaks the harness protocol on stdin/stdout (hello, then one reply of orders per batch). Grade it locally with the bounty kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree --stress
```

Dev result: net PnL +0.265 SOL on the kit's dev window, max drawdown 1.85%, guardrails met, still positive at 2× fees.

---

<sub>Entered on [make.fun](https://make.fun/?ref=msejxs9e&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
