# Design language

This project follows the **ARKS Design Language Color Spec** — a copy lives at
[`arks-color-spec.html`](arks-color-spec.html) in this folder. Open it in a
browser; every swatch copies its hex on click.

The canonical copy lives in `arks-internal`. The copy here exists so the
palette ships with the code and is available offline. If the two ever
disagree, `arks-internal` wins.

## Which palette this project uses

The spec offers six languages. Two were written for exactly this kind of
project, and the arcade uses both:

| Where | Palette | Why |
|---|---|---|
| Arcade hub, Wordless, Rambler (kids dictionary) | **8-Bit** | The spec assigns it to "a retro arcade/game-room mode — the kid request board as a *quest log*, achievement pop-ups, anything that wants a coin-op wink." That is a literal description of what got built: a theme-request board the kids submit to, a milestone system, and an initials leaderboard. |
| Rambler on the unfiltered dictionary | **Vice** | The spec's "late-night lights-off vibe". Switching palette with the dictionary makes adult mode *look* different the moment it is on — which is a safety feature as much as a style one, since you can tell across the room which mode a kid is holding. |

Summit is the other candidate — the spec assigns it to "anything with a
gamification layer", and streaks, coins and milestones qualify. It is held in
reserve; two palettes in one app is already the limit before it stops reading
as one product.

## Status: not yet applied

**The current UI is off-spec.** It was built before the palette existed and
uses ad-hoc values:

| Currently | Should be |
|---|---|
| `--bg: #0f1115` | 8-Bit background `#12111C` |
| `--accent: #facc15` | 8-Bit accent `#FFC72C` |
| `--trace: #7dd3fc` | 8-Bit accent 2 `#2E9BFF` |
| `--good: #4ade80` | 8-Bit good `#3CD070` |
| `--bad: #f87171` | 8-Bit bad `#FF3B30` |

Close enough to look deliberate, far enough to be wrong. Retheming is a
contained job — `public/rambler.css` and `public/style.css` both already
define their colours as CSS custom properties at `:root`, so it is a token
swap rather than a rewrite.

## Rules inherited from the spec

These are not negotiable per-project — they come from the spec and apply here
on day one:

- Status colours are **reserved**. Never a chart series, never decoration.
- Status is **never colour alone** — always colour + icon + word. The results
  screen already obeys this: a cancelled word is struck through *and* labelled
  "everyone found it", not merely greyed.
- Charts sit on the chart plate, never directly on a panel.
- Nothing hard-coded. If a colour appears twice, it is a token.
- The chart series is validated for colour-vision deficiency as a set.
  **Never re-tint it per theme** — there is no way to tell by eye that you
  have broken it.
