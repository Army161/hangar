# HANGAR — Pricing analysis

**Status:** research and recommendation. Nothing built. Supersedes the tier table
in [PLAN.md §5](PLAN.md), which it otherwise agrees with.

**Prepared:** 2026-08-15 · prices verified same day, all USD

---

## 1. The market, measured

Two clusters price this product, and they price it very differently.

### System and process utilities — what Hangar *is*

| Product | Free tier | Paid | Model |
|---|---|---|---|
| **Process Lasso** | Yes, limited | **$29.95/yr** · $99.95 lifetime | Sub or perpetual |
| **Sensei** | No | **$29/yr** · $59 lifetime (3 Macs) | Sub or perpetual |
| **iStat Menus** | No | **$18** one-time · $29 family | Perpetual |
| **Little Snitch** | No | **$59** one-time | Perpetual |
| **CleanMyMac** | Trial | **$47.50/yr** basic · $71.40/yr Plus · $119.95 lifetime | Sub |

Cluster: **$18–60 one-time, or $29–48/yr.** Buyers here expect to own the thing.

### Power-user desktop tools with AI — what Hangar *is becoming*

| Product | Free tier | Paid | Note |
|---|---|---|---|
| **Raycast** | Generous | **$8/mo annual** ($96/yr) · $10/mo monthly | Held since 2023 |
| — Advanced AI add-on | — | +$8/mo | Premium models |
| — Teams | — | $12/user/mo | |
| **Zed** | **Unlimited BYOK** | $10/mo Pro · $30/seat Business | |
| **Cursor** | Limited | $20/mo (incl. $20 usage) · **unlimited BYOK** | |
| **Warp** | 75 credits/mo | $20/user/mo Build · $50/user/mo Business | Credit model, 2026 |

Cluster: **$8–20/mo individual, $12–50/seat team.**

### The three findings that should drive the decision

**1. Raycast has held $8/$10 for three years.** In the closest analogous category —
a desktop power tool for technical users, with AI — that is the market's revealed
stable price. It is the strongest single anchor available.

**2. Zed gives unlimited BYOK away on the free tier. So does Cursor.** This is the
uncomfortable one. If Hangar puts *bring your own API key* behind a paywall, it is
charging for something two well-funded competitors give away. BYOK cannot be the
paid feature. It has to be free, and the paid tiers must sell something else.

**3. Credit models are replacing flat subscriptions** — Cursor, Augment, Windsurf
all moved. **This does not apply to Hangar.** Credits exist because those vendors
buy inference and must pass through COGS. Under BYOK, Hangar's marginal cost per
agent request is **zero**. Copying a credit model would import the complexity and
the customer resentment while solving a problem Hangar does not have.

---

## 2. What Hangar can actually charge for

[PLAN.md §5](PLAN.md) sets a constraint worth protecting: *"The app must remain
fully functional with the network unplugged. A licensing server that can brick the
free tier is a non-starter."*

That rules out gating the core loop. What remains is genuinely additive:

| Lever | Gateable? | Why |
|---|---|---|
| Local map, ports, origins, park/restore | **No** | The wedge. Gating it kills adoption. |
| BYOK cloud models | **No** | Zed and Cursor give it away. |
| Local models (Ollama) | **No** | Costs nothing; a free-tier differentiator. |
| Machines beyond the first | Yes | Real value, obvious boundary. |
| History and timeline | Yes | Needs storage; genuinely additive. |
| Graveyard Scanner | Yes | Discrete, high-value, expensive to compute. |
| Agent **execute** tier | Careful | See §4. |
| Fleet view, SSO, audit, shared policy | Yes | Textbook team features. |
| Hosted inference (no key needed) | Yes | Real COGS — must be metered. |

---

## 3. Recommended ladder

Annual at **10 months for 12** (~17% off), the market standard.

| | **Free** | **Plus** | **Pro** | **Max** |
|---|---|---|---|---|
| **Monthly** | $0 | **$6** | **$12** | **$29/seat** |
| **Annual** | $0 | **$60** ($5/mo) | **$120** ($10/mo) | **$290/seat** |
| Machines | 1 | 3 | 10 | Unlimited |
| Local map, ports, origins | ✓ | ✓ | ✓ | ✓ |
| Park / restore / persistence | ✓ | ✓ | ✓ | ✓ |
| Local models (Ollama) | ✓ | ✓ | ✓ | ✓ |
| **BYOK cloud models** | ✓ | ✓ | ✓ | ✓ |
| Agent — chat + plan | ✓ | ✓ | ✓ | ✓ |
| Agent — execute (gated) | ✓ | ✓ | ✓ | ✓ |
| History & timeline | — | 30 days | Unlimited | Unlimited |
| Graveyard Scanner | — | ✓ | ✓ | ✓ |
| Multi-machine sync | — | — | ✓ | ✓ |
| Secret / credential audit | — | — | ✓ | ✓ |
| Scheduled sweeps | — | — | ✓ | ✓ |
| Fleet view | — | — | — | ✓ |
| Shared protect policies | — | — | — | ✓ |
| SSO + audit log | — | — | — | ✓ |
| Priority support | — | — | ✓ | ✓ |

**Pro at $12/$120 is unchanged from PLAN §5.** That number survives the cross-check:
it sits above Raycast Pro ($8) — justified, Hangar is higher-stakes and narrower —
and below Cursor and Warp ($20), which it should, since they buy inference and
Hangar does not.

**Plus at $6/$60** is new. It exists to catch the single-machine enthusiast who
wants Graveyard and history but will never pay $12. At $5/mo annual it is an
impulse, not a decision.

**Max is the team tier, renamed.** See the warning in §5.

---

## 4. One recommendation against the brief

**Do not gate the agent's execute tier by price.**

PLAN §4 is unambiguous: every execute passes a human-typed confirmation phrase,
*"No exceptions, no setting to disable it."* That gate is a safety property, and
the 2026-07-29 MetaTrader incident is why it exists.

Selling a tier that changes what the agent may do converts a safety boundary into
a commercial one. It creates pressure — from customers, then internally — to
loosen it. And the first support ticket asking "I paid for Max, why do I still
have to type the phrase?" is a conversation that should never be possible.

Sell **scale** — machines, history, fleet, sync. Never sell **permission**.

---

## 5. Where I think the four-tier brief is wrong

You asked for Free / Plus / Pro / Max. The table above delivers it. But the
comparison does not support four tiers, and you should hear that plainly:

- Raycast: Free / Pro / Teams — **three**
- Zed: Free / Pro / Business — **three**
- Warp: Free / Build / Business — **three**
- Cursor: Free / Pro / Business — **three**

Nobody in this category runs four. Four tiers works for API platforms, where usage
scales continuously and tiers are just volume brackets. For a desktop tool, each
extra tier costs a real decision from the buyer, and decision cost suppresses
conversion. The classic failure is the third paid tier that nobody picks, which
still has to be built, documented, supported and tested forever.

**The honest recommendation is three: Free / Pro ($12) / Team ($29 seat).** That is
PLAN §5, which was already right.

**If you want four, the version above is the one to ship** — because Plus at $6
targets a real, distinct buyer, and Max is Team wearing a different name rather
than an invented personal tier. What I would not build is a personal tier above
Pro. There is nothing left to put in it that is not either a safety boundary (§4)
or hosted inference, which is a different business with real COGS.

---

## 6. The sweet spot, and why

For the **individual** buyer the sweet spot is **$10–12/mo**, and annual is where
the money is.

- Below $8 you are under Raycast, which signals "less serious" in a category where
  the product's whole claim is that it is safe enough to trust with process kill.
- Above $15 you are in Cursor and Warp territory, where buyers expect included
  inference. Hangar has none to include — the user brings their own key.
- $12/mo · $120/yr sits precisely between, and the annual framing ($10/mo) lands
  under the psychological $10 line while collecting twelve months up front.

The larger lever is not price, it is **conversion**. With zero marginal cost per
user, a free tier that runs forever, offline, on one machine, costs almost nothing
and is the entire acquisition engine. Protect it.

---

## 7. What is not decided here

- **Perpetual licence option.** Half the utility cluster sells one-time
  (iStat $18, Little Snitch $59, Process Lasso $99.95 lifetime). Buyers in this
  category ask for it. A lifetime at ~$249 is defensible and would convert some
  subscription refusers, but it caps LTV and complicates support forever. Needs a
  separate decision.
- **Hosted inference.** The only credible reason for a personal tier above Pro.
  Real COGS, so it must be metered — a different pricing exercise.
- **Regional pricing.** Worth doing eventually; not at launch.
- **Education / OSS discounts.** Cheap goodwill in a developer tool.

---

## Sources

Prices verified 2026-08-15.

- [Process Lasso — Bitsum](https://bitsum.com/get-lasso-pro/)
- [Raycast pricing 2026](https://raycast-discount-code.com/blog/raycast-pricing-2026)
- [CleanMyMac pricing 2026 — Macworld](https://www.macworld.com/article/352922/cleanmymac-x-review-macos.html)
- [Little Snitch 6 — AlternativeTo](https://alternativeto.net/news/2024/5/little-snitch-6-a-new-era-of-enhanced-network-monitoring-and-protection-for-macos)
- [Warp pricing — CompareToolz](https://www.comparetoolz.com/pricing/warp)
- [iStat Menus / Sensei — Cindori](https://cindori.com/reviews/best-mac-performance-monitor-apps)
- [BYOK AI coding tools 2026](https://copilot-alternatives.com/blog/best-byok-ai-coding-assistants-2026/)
- [Cursor vs Zed 2026](https://devtoolpicks.com/blog/cursor-vs-zed/)
