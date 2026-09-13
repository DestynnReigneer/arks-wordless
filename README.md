# Wordless Arcade

A self-hosted arcade of two word games, served from one Node.js + Express + SQLite container. No external database, no internet access at runtime, no accounts.

`/` is the arcade hub; each game lives on its own page.

## The games

### Wordless (`/wordless.html`)

A themed word-guessing game, Wordle-style.

- Guess a themed word in 6 tries, with 3 limited hints per round
- Arcade-style scoring (guesses, hints, and speed all factor in), computed server-side
- A shared, persistent leaderboard — per theme, and an "All Themes" combined view
- Kids submit theme ideas from the game; you get notified on Discord and fulfill them from an admin panel

### Word Shaker (`/shaker.html`)

A dice-and-grid word hunt against the clock. (Boggle-style — "Boggle" is a Hasbro trademark, hence the different name.)

- Rolls the **real printed dice**: the 16-die 4x4 set and the 25-die 5x5 Big set, Qu tile included. Boards are re-rolled until they hold enough words to be worth playing.
- Standard scoring (3–4 letters = 1, 5 = 2, 6 = 3, 7 = 5, 8+ = 11); 5x5 boards require four letters.
- **Duplicate cancellation** — a word more than one player found scores nothing for anyone, which is the rule that makes hunting obscure words pay.
- End-of-round reveal showing every word nobody found.
- Four ways to play:
  - **Solo** — you against the clock.
  - **Pass & Play** — one phone, 2–8 players, same board each turn.
  - **Tabletop** — one shared timer, everyone writes on paper, then the lists get typed in for scoring. The phone is just the buzzer and the scorekeeper.
  - **Own Phones** — a four-letter room code, everyone on their own device, synchronised timer, live word counts (counts only — never the words).
- Two dictionaries: a **Kids** list with the rude words removed, and an **Unfiltered** list with slang and profanity added on top. Separate leaderboards, so the two never share a scale.

Multi-device rooms use Server-Sent Events, which are built into Node and the browser — no websocket dependency. Rooms are in-memory and vanish on restart; only finished scores are persisted.

### A note on the dictionaries

ENABLE1 is a Scrabble tournament word list, so out of the box it already accepts essentially every swear word there is. That means the kids' blocklist is the load-bearing part, not the adult supplement.

Edit these by hand — they are plain text, one word per line, `#` for comments:

| File | What it does |
|---|---|
| `words/enable1.txt` | The base list (~172,000 words, public domain). |
| `words/blocklist-kids.txt` | Base words removed from the Kids dictionary. Inflections are generated, so listing `wank` also blocks `wanks`/`wanked`/`wanker`. |
| `words/allowlist-kids.txt` | Exact words the blocklist must never catch. Exists because inflecting stems produces false positives — `heroin` generates `HEROINES`, `bonk` generates `BONKERS`. |
| `words/supplement-adult.txt` | Words added to the Unfiltered dictionary that ENABLE1 lacks: slang, British vernacular, anything coined recently. |
| `words/common-10k.txt` | Frequency list used only to decide which words are "common" enough to show a child on the reveal screen. |

Validation always uses the full list, so a real word is never rejected as fake — only the blocked ones are. Slurs aimed at race, sexuality, or disability are in neither list.

### Shared

- Ships as a single Docker image with a SQLite file as its only state

## Running locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Running with Docker

```bash
cp .env.example .env   # ADMIN_TOKEN (required for admin), DISCORD_WEBHOOK_URL and ADULT_PIN (both optional)
docker compose up -d --build
```

## Deploying from a pre-built image (homelab)

Once the GitHub Actions workflow (`.github/workflows/docker-publish.yml`) has published an image to GHCR, deploy anywhere with just this file — no need to clone the repo:

```yaml
services:
  wordless-arcade:
    image: ghcr.io/YOUR_GITHUB_USERNAME/wordless-arcade:latest
    container_name: wordless-arcade
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_TOKEN=${ADMIN_TOKEN}
      - DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL}
      - ADULT_PIN=${ADULT_PIN}
    volumes:
      - ./data:/app/data
```

```bash
docker compose pull
docker compose up -d
```

Put this behind a reverse proxy (Caddy/Traefik/NPM) for HTTPS before exposing it to the internet — see the deployment guide for details.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | Yes, for admin features | Shared secret for `public/admin.html`. Without it, theme creation/deletion and viewing theme requests are disabled entirely. |
| `DISCORD_WEBHOOK_URL` | No | Discord incoming webhook URL. When set, a message is posted whenever a kid submits a theme suggestion. |
| `ADULT_PIN` | No | Locks Word Shaker's Unfiltered dictionary behind a PIN. Leave it blank and a confirmation tap is the only thing guarding it, which is fine on a LAN — set it once the server is reachable from outside. |
| `PORT` | No | Defaults to `3000`. |

## Admin panel

Visit `/admin.html`, enter your `ADMIN_TOKEN`, and you can:
- See pending theme requests, with a one-click "Copy Prompt" to paste into an AI chatbot (or use however you like) to generate the theme's word list
- Paste the resulting JSON back in to create the theme and mark the request fulfilled
- Delete custom themes

## Project structure

```
server.js                 Express app, Wordless API routes, mounts the Shaker router
db.js                     SQLite schema for both games, built-in themes, Wordless scoring

shaker/                   Word Shaker, self-contained
  dice.js                 The real printed die faces, board rolling, path finding
  dictionary.js           Word lists -> one trie, with a profile bitmask per word
  solver.js               Finds every word on a board (~1ms for 4x4)
  scoring.js              Scoring table + duplicate cancellation
  boards.js               Server-side board store, so scoring never trusts the client
  round.js                Board creation, word validation, end-of-round scoring
  rooms.js                In-memory multi-device rooms over Server-Sent Events
  routes.js               Everything under /api/shaker

words/                    Dictionaries, baked into the image (see above)

public/index.html         The arcade hub
public/wordless.html/.js  Wordless
public/shaker.html/.js    Word Shaker
public/admin.html/.js     Admin panel

Dockerfile
docker-compose.yml
.github/workflows/        CI: builds & publishes the Docker image to GHCR
```
