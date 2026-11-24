// SPDX-License-Identifier: MIT
// Pump.fun Paper Sprint entry: a momentum paper-trading bot for agent-fun/replay/v2.
// The strategy lives in strategy.ts; this file only wires it to the harness shim.
// Paper trading only — the replay feeds market data, never real funds.
import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

await runBot(createBot());
