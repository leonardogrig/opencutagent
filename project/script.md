Script: Opus 5 vs Fable 5.1, which is cheaper for agentic coding

Read straight through. Short blocks so you can pace each one. The result is stated up front; the rest is the calculation.
[OPEN: url] marks where to show a page. [SHOW TABLE n] marks where to cut to a table. (ANIMATION: ...) is the core idea for the visual under that block.
The AA model page for Fable 5.1 was a 404 when I checked; recheck before recording.

---

In this video I'm doing a full cost breakdown between Fable 5.1 and Opus 5, specifically for agentic coding.

Fable 5.1 came out yesterday, so we don't know its full capability yet, and the results here might look different in practice.

Everything here comes from Anthropic's own numbers, one independent lab, and published session data I researched and ran the math on.

(ANIMATION: two model cards side by side, Fable 5.1 and Opus 5, with a "$?" between them. Then three small source icons appear under it: Anthropic, an independent lab, a session log.)


The result first. For most coding, Opus 5 is still cheaper. 20 to 45% cheaper per finished task.

Fable 5.1 wins in three cases: MCP-heavy sessions past about 60 turns, long runs where you let the context grow, and research work where its pass rate is almost double.

And there's one number that could flip all of it, how many tokens Fable actually uses per task, and nobody agrees on it yet.

If you're staying, here's how I got there.

(ANIMATION: a scorecard. Opus badge on "most coding, 20 to 45% cheaper". Fable badge on the three icons: plug, moon, research flask. A "?" card at the bottom.)


Before any pricing, the quality difference.

Fable 5.1 is the better model, so comparing per-token prices alone would be unfair to it.

Here's Anthropic's benchmark table.

[OPEN: https://www.anthropic.com/claude-fable-and-mythos-5-1, benchmark table]

[SHOW TABLE 1]

| Benchmark | Fable 5.1 | Opus 5 |
|---|---|---|
| Terminal-Bench 4.0 (agentic coding) | 55.8% | 52.3% |
| CursorBench 3.2.0 (agentic coding) | 73.4% | 70.0% |
| AutomationBench (business workflows) | 31.4% | 26.9% |
| OSWorld 2.0 strict (computer use) | 41.7% | 39.6% |
| Terminal-Bench-Science (research) | 52.6% | 29.0% |
| Humanity's Last Exam, no tools | 60.9% | 56.6% |

On coding it's a few points better. On research it's almost double.

(ANIMATION: highlight the coding rows with a small gap between the two bars, then the research row with a big gap.)


That gets priced in two ways.

First, a better model fails less. When a model fails, you pay for the run, and then you pay again.

So I'm measuring cost per finished task, which is cost per attempt divided by pass rate.

(ANIMATION: two chat UIs side by side. Left: one prompt sent, result comes back done, one price tag. Right: prompt sent, result comes back incomplete, second prompt sent, then done, two price tags stacked.)


Second, a smarter model might finish the same job in fewer tokens.

So every scenario is run at same tokens, at 20% fewer, and at half, and then checked against the one independent measurement that exists.

That measurement disagrees with Anthropic's partners, and we'll get to that.

(ANIMATION: one task, two token bars underneath it. The Fable bar shrinks from 100% to 80% to 50%. A small "?" appears at the end.)


Now the situation before yesterday.

Fable 5 was better than Opus 5, but only by a bit on most things, and it cost exactly double.

So most people ran Opus 5 in Claude Code, because you got almost the same quality and twice the work for the money.

The question is whether that still holds with Fable 5.1, because one thing changed.

(ANIMATION: a scale. Left pan "Fable 5: a bit better", right pan "Opus 5: 2x the work". It tips to Opus. Then a "5.1" badge lands on the left pan and the scale wobbles.)


[OPEN: https://platform.claude.com/docs/en/models/fable-5-1/overview, pricing section]
[OPEN: https://platform.claude.com/docs/en/models/opus-5/overview, pricing section]

[SHOW TABLE 2]

| Per million tokens | Fable 5.1 | Opus 5 | Fable vs Opus |
|---|---|---|---|
| Input (uncached) | $10.00 | $5.00 | 2x |
| Output | $50.00 | $25.00 | 2x |
| Cache write, 5 min | $12.50 | $6.25 | 2x |
| Cache write, 1 hour | $20.00 | $10.00 | 2x |
| Cache read | $0.25 | $0.50 | 0.5x |

Every line is double, except cache reads.

Fable is 25 cents, Opus is 50. The expensive model is half price on that one line.

(ANIMATION: the table with every "2x" cell dimmed, and the single "0.5x" cell lit up.)


And that line is most of what Claude Code does.

It resends the entire conversation every turn. System prompt, CLAUDE.md, tools, every file it read, every result.

The first time you pay a cache write. Every turn after that you pay a cache read.

(ANIMATION: a chat conversation growing turn by turn. Each new turn, the whole stack above it flashes as it gets resent. First flash labeled "cache write", every next flash labeled "cache read".)


[OPEN: https://docs.rs/crate/ccusage-rs/latest, example breakdown]

Here's a published ccusage report from one day in Claude Code.

8K uncached input. 20K output. 1.5 million cache writes. 16.6 million cache reads.

92% of all tokens were cache reads.

[OPEN: https://docs.rs/ccwhy, "Fixed Overhead" line]

Another tool, across 3.2 billion tokens: 97%.

(ANIMATION: a stacked bar of the four token types. The cache-read segment fills almost the whole bar. "92%" then "97%".)


So cache reads are most of your tokens. Whether they're most of your dollars is the actual question, and there's a clean answer.

Call X what you pay Opus for everything except cache reads, and Y what you pay for cache reads.

The Opus bill is X plus Y.

Fable doubles X and halves Y, so the Fable bill is 2X plus half Y.

Set them equal, and X equals half Y. Which means Y is two thirds of the bill.

So at the same token count, Fable 5.1 is cheaper than Opus 5 only when cache reads are more than 66.7% of your Opus bill.

(ANIMATION: the equations appearing line by line, ending with a pie chart where the cache-read slice grows until it crosses the 2/3 mark and the "cheaper" label flips from Opus to Fable.)


How close do real workloads get? Anthropic told us without meaning to.

[OPEN: https://www.anthropic.com/claude-fable-and-mythos-5-1, "Cost and availability" indexed cost chart]

They say 25% cheaper than Fable 5 on typical work and 45% on highly agentic work, and the only thing that changed is cache reads dropping 75%.

Work that backwards, and cache reads were 33% of a typical bill and 60% of a highly agentic one.

Opus is exactly half of Fable 5 on every line, so those shares carry straight over.

Typical work: Fable 5.1 costs 1.5x Opus. Highly agentic: 1.1x.

Even Anthropic's own best case doesn't reach the crossover. At the same tokens, Opus still wins by 10%.

(ANIMATION: Anthropic's two bars, 100 to 75 and 100 to 55. The removed chunk gets labeled "this was cache reads: 33%" and "60%". Then both numbers land on the pie chart from before, both short of the 2/3 line.)


But nobody thinks in cache percentages.

So I priced seven real jobs, modeled the way Claude Code actually loops.

Turn one writes the starting context to cache. Every turn after reads the whole context from cache, writes the new tool results to cache, and generates output that becomes context.

300 uncached tokens per turn. When context gets big it compacts to a summary, the way Claude Code does.

(ANIMATION: a simple loop diagram: read context from cache, write new results, generate output, back to top. A context meter on the side fills up and then drops when "compact" fires.)


[SHOW TABLE 3]

| Scenario | Turns | Start ctx | Added per turn | Output per turn | Compaction |
|---|---|---|---|---|---|
| 1. Landing page, one shot | 3 | 6K | 4K | 5K | none |
| 2. Bug fix in an existing repo | 15 | 25K | 6K | 1.2K | none |
| 3. Build a small app | 80 | 30K | 7K | 1.5K | at 200K, down to 40K |
| 4. Automation with MCP servers | 30 | 45K | 10K | 1K | none |
| 4b. Same, longer | 60 | 45K | 10K | 1K | none |
| 5. Overnight agent run | 300 | 30K | 8K | 1.5K | at 200K, down to 40K |
| 5b. Overnight, 1M window used | 300 | 30K | 8K | 1.5K | at 800K, down to 60K |

Claude Code's base prompt plus tool names is about 4K, and a CLAUDE.md plus a few files gets you to 25K fast.

[OPEN: https://dev.to/wartzarbee/i-added-mcp-servers-to-claude-code-heres-what-they-cost-in-tokens-2can, measurement table]

For MCP, someone measured the GitHub server at about 3.1K tokens per turn and schemas at 300 to 600 each, so 45K to start with a couple of servers is conservative.

MCP results are JSON, so 10K per turn.

Output of 1 to 1.5K per turn is a normal coding step, and the landing page gets 5K because it writes a whole file at once.

(ANIMATION: the seven scenarios as icons in a row: a web page, a bug, an app, a plug for MCP, a longer plug, a moon, a bigger moon. Each one shows its turn count under it.)


These are assumptions, and yours might be different. If you see a number that's off, or a variable I should've included, put it in the comments and I'll rerun it.

(ANIMATION: the assumptions table with a comment bubble pointing at one of the cells.)


Here's what came out.

[SHOW TABLE 4]

| Scenario | Cache-read tokens | Fable 5.1 | Opus 5 | Fable / Opus | Cache reads as % of Opus bill |
|---|---|---|---|---|---|
| 1. Landing page | 31K | $0.94 | $0.48 | 1.95x | 3% |
| 2. Bug fix | 1.02M | $2.56 | $1.66 | 1.54x | 31% |
| 3. Build an app | 8.97M | $17.77 | $12.25 | 1.45x | 37% |
| 4. MCP automation, 30 turns | 5.80M | $7.23 | $5.79 | 1.25x | 50% |
| 4b. MCP automation, 60 turns | 21.5M | $16.50 | $16.33 | 1.01x | 66% |
| 5. Overnight, compacted at 200K | 34.3M | $70.74 | $48.22 | 1.47x | 36% |
| 5b. Overnight, compacted at 800K | 121.4M | $86.28 | $88.68 | 0.97x | 69% |

The landing page is the worst case for Fable. Three turns, nothing cached, double for everything. 94 cents versus 48.

(ANIMATION: the two price tags, $0.94 and $0.48, with an almost empty cache-read bar.)


The two overnight runs are the same 300 turns, and the only difference is compacting at 200K or 800K.

Compact early, and Fable is 47% more. Compact late, and Fable is 3% cheaper.

That's backwards from what you'd guess, because compaction keeps context small, which keeps cache reads small, and that's the only line Fable is cheap on.

(ANIMATION: two context meters running side by side over 300 turns. One saws up and down at 200K, one climbs to 800K. The Fable/Opus ratio under each: 1.47x and 0.97x.)


And MCP work, a big block of schemas that never changes, fat results, small outputs, is the exact shape Fable is priced for.

25% more at 30 turns, dead heat at 60.

As a sanity check, that real ccusage day at today's prices is $23.98 on Fable and $18.21 on Opus. 1.32x, which sits between my bug fix and my MCP scenario.

(ANIMATION: the ratios from table 4 on a number line, with the real ccusage day dropping in at 1.32 between the bug fix and MCP markers.)


That's all at equal tokens with both models finishing. Now the quality.

Take the pass rates from earlier and turn them into tries per success.

[SHOW TABLE 5]

| Benchmark | Fable 5.1 | Opus 5 | Tries per success, Fable | Tries per success, Opus |
|---|---|---|---|---|
| Terminal-Bench 4.0 (agentic coding) | 55.8% | 52.3% | 1.79 | 1.91 |
| CursorBench 3.2.0 | 73.4% | 70.0% | 1.36 | 1.43 |
| AutomationBench (business workflows) | 31.4% | 26.9% | 3.18 | 3.72 |
| OSWorld 2.0 strict (computer use) | 41.7% | 39.6% | 2.40 | 2.53 |
| Terminal-Bench-Science (research) | 52.6% | 29.0% | 1.90 | 3.45 |

On coding, Fable needs 1.79 tries per success and Opus 1.91. A 6% edge. Real, but not enough to flip 1.4x.

(ANIMATION: the side-by-side chat UI again. Both sides need almost the same number of prompts on coding. Then on research, the Opus side keeps needing more prompts.)


Multiply it through every scenario, and you get cost per finished task.

[SHOW TABLE 6]

| Scenario | Coding (TB 4.0) | Cursor-style | Automation | Computer use | Research |
|---|---|---|---|---|---|
| Bug fix | 1.44x | 1.47x | 1.32x | 1.46x | 0.85x |
| Build an app | 1.36x | 1.38x | 1.24x | 1.38x | 0.80x |
| MCP automation, 30 turns | 1.17x | 1.19x | 1.07x | 1.19x | 0.69x |
| MCP automation, 60 turns | 0.95x | 0.96x | 0.87x | 0.96x | 0.56x |
| Overnight, compact at 200K | 1.38x | 1.40x | 1.26x | 1.40x | 0.81x |
| Overnight, compact at 800K | 0.91x | 0.93x | 0.83x | 0.92x | 0.53x |

The bug fix goes from 1.54x to 1.44x. The app build from 1.45x to 1.36x. Opus still cheaper.

Automation moves more, because both models fail a lot there, 31% versus 27%, and failing less matters more when everyone fails.

So the 60-turn MCP session lands 13% cheaper on Fable.

Research flips everything, because Fable's pass rate is 1.8x Opus's and Opus needs three and a half tries on average.

So even the short scenario is 15% cheaper on Fable.

(ANIMATION: table 4's ratios sliding slightly down into table 6's ratios for coding, and the research column dropping hard below 1.0.)


One caveat. This treats a failed run as a clean retry, and in real life it also burns your time and can leave a mess.

That pushes toward Fable. I can't put a number on it, so I didn't.

(ANIMATION: the incomplete-result chat from before, with a clock ticking and a small "cleanup" icon next to the second prompt.)


Those pass rates are Anthropic's.

Artificial Analysis runs the same tasks on every model and bills at list price with cache included, and they tested Fable 5.1 before launch.

[OPEN: https://www.linkedin.com/posts/artificial-analysis_claude-fable-51-tops-the-artificial-analysis-activity-7500649293469335552-6g83]
[OPEN for Opus 5: https://artificialanalysis.ai/articles/opus-5]

[SHOW TABLE 7]

| Model and effort | Score | Cost per task | Cost per 100 points |
|---|---|---|---|
| Fable 5.1, max | 66 | $3.76 | $5.70 |
| Fable 5.1, xhigh | 65 | $2.72 | $4.18 |
| Opus 5, max | 63 | $2.34 | $3.71 |
| Fable 5, max | 62 | $3.14 | $5.06 |

Fable 5.1 at max: 66 points, $3.76 per task. Opus 5 at max: 63 points, $2.34.

That's 1.61x for three points.

Fable at xhigh is 65 points at $2.72. 1.16x for two points.

Opus cheaper per task and per point.

(ANIMATION: a scatter with score on one axis and cost per task on the other. Four dots. Opus 5 sits lower-left of both Fable 5.1 dots.)


And here's the biggest thing in this video.

Artificial Analysis found Fable 5.1 at max uses about 1.7x the output tokens of Fable 5.

So even with the cache cut saving about $1.40 per task, Fable 5.1 at max costs 20% more per task than Fable 5.

That is the opposite of what Anthropic's launch partners reported.

(ANIMATION: two output-token bars, Fable 5 and Fable 5.1, the 5.1 bar 1.7x longer. A "-$1.40" cache saving appears and then a "+20%" net lands on top of it.)


[OPEN: https://www.anthropic.com/claude-fable-and-mythos-5-1, partner quotes from Every, Rogo, Browserbase]

Every said half the tokens of Opus 5. Rogo said 20% fewer than Fable 5. Browserbase said fewer than either.

They can't all be right.

My best guess is effort level. The partners probably tested at the default High or Medium, and AA's number is at max, where the model thinks longer.

Anthropic's own chart says Fable 5.1 at Low or Medium matches Fable 5 at lower cost, which fits that.

But nobody has published the comparison at matched effort.

So "Fable uses fewer tokens," which is the entire case for Fable on normal coding, is unconfirmed right now.

(ANIMATION: three partner quote cards pointing one way, the AA card pointing the other. Then an effort dial appears between them, labeled Medium on one side and Max on the other, with a "?" in the middle.)


If it does use fewer tokens, here's what that does.

[SHOW TABLE 8]

| Scenario | Same tokens | 20% fewer | Half |
|---|---|---|---|
| 1. Landing page | 1.95x | 1.56x | 0.98x |
| 2. Bug fix | 1.54x | 1.23x | 0.77x |
| 3. Build an app | 1.45x | 1.16x | 0.73x |
| 4. MCP automation, 30 turns | 1.25x | 1.00x | 0.62x |
| 4b. MCP automation, 60 turns | 1.01x | 0.81x | 0.51x |
| 5. Overnight, compact at 200K | 1.47x | 1.17x | 0.73x |
| 5b. Overnight, compact at 800K | 0.97x | 0.78x | 0.49x |

At 20% fewer, Fable ties on 30-turn MCP work and wins the long stuff, and Opus keeps bug fixes and app builds.

At half, like Every says, Fable wins everything.

And if Fable at max really uses more tokens, like AA measured, Fable's numbers get worse than the same-tokens column, not better.

Break-even, if you want to test it: Fable needs 65% of Opus's tokens on a bug fix, 69% on an app build, 80% on 30-turn MCP work.

(ANIMATION: the token bar under Fable shrinking through 100, 80, 50 while the ratio column next to it recolors from red to green row by row.)


Which brings up the effort dial, because it might matter more than the model.

Fable 5.1 defaults to High in Claude Code and the API, and Medium in claude.ai.

[OPEN: https://www.anthropic.com/claude-fable-and-mythos-5-1, Terminal-Bench-Science accuracy vs cost chart]

Fable 5.1 at Low scores 26% at about $11 per task. Fable 5 at Max scores 24.7% at about $44.

Same result, four times cheaper, from the dial alone.

In the AA data, going from max to xhigh cut cost 28% and lost one point.

So the cheapest way to run Fable 5.1 is probably Medium, and that's a setting, not a model switch.

(ANIMATION: an effort dial turning from Max down to Low, with a price tag next to it dropping from $44 to $11 and the score staying flat.)


So, which one.

Landing page or a single component: Opus 5. Fable is double and there's nothing for the cache discount to touch.

(ANIMATION: web page icon, Opus badge.)

Bug fix in an existing repo: Opus 5, 44% cheaper per finished task.

With one exception, the bug nobody can find. Millennium had a one-in-a-million crash that went unexplained for years, and Fable 5.1 found it. For that bug, the session cost is irrelevant.

(ANIMATION: bug icon, Opus badge. Then a "1 in a million" bug icon with a Fable badge.)

Building an app over a few hours: a toss-up.

Opus is 26% cheaper per finished task, and the benchmark gap here is small, so don't assume the efficiency win. Measure it.

(ANIMATION: app icon, both badges, a "?" between them.)

Automations with MCP servers: this is where I'd try Fable first.

7% more at 30 turns, 13% cheaper at 60. And it's the reason Cognition is moving Devin's Opus traffic over.

(ANIMATION: plug icon, Fable badge, a turn counter ticking from 30 to 60 as the ratio crosses 1.0.)

Long autonomous runs: one setting decides it.

Compact hard, and Opus is cheaper at 1.38x. Use the 1M window and compact late, and Fable is 9% cheaper.

And a model that drifts at hour six costs you the whole night anyway.

(ANIMATION: moon icon, the two context meters from before, badge flips depending on which one is shown.)

Subagents copy the parent's context and read it from cache every turn, which moves everything toward Fable. I didn't model them.

And none of this applies on Max, Pro, or Team seats. The cache discount only exists where you pay per token.

(ANIMATION: one parent context box spawning three copies. Then a subscription badge with the cache-read line crossed out.)


So Fable 5.1 isn't 45% cheaper. It's the same price with one cell changed.

For most coding, Opus 5 is still 20 to 45% cheaper per finished task.

Fable wins on MCP sessions past about 60 turns, on long uncompacted runs, and on research work where its pass rate is nearly double.

And the number that decides the rest, how many tokens Fable actually uses per task, is the one where Anthropic's partners and the only independent lab disagree.

If you run that at matched effort, send it to me.

Full math is in the doc below with every assumption listed. If I got a calculation wrong or missed something, the comments are the place.

(ANIMATION: the price table with the single lit cell one more time, then the three winning scenario icons for Fable, then the effort dial with the "?".)
