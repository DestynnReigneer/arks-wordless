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

### Rambler (`/rambler.html`)

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
- **Difficulty** — Easy (three-letter words count, roomier timer, richer boards), Normal (the box rules), Hard (four letters minimum, less time, scores multiplied by 1.35).
- **Timers up to ten minutes.** Three is the box rule and it is genuinely miserable for a seven-year-old.

#### Marathon

The mode that isn't in the box. You start on a small board with a short clock, and **every word you find buys you more time** — three seconds for a short one, twenty-five for an eight-letter monster. Find enough and **the grid grows a row or column** on a random side, opening letters that weren't reachable a moment ago. You never win; you last.

Because of Marathon, boards are rectangular internally. Anything that takes a board accepts `{ cols, rows }`, and a plain number still means a square.

#### Gamification

- **Profiles** — one per person, with an avatar, picked from a "Who's playing?" screen. Not accounts: no password, no email.
- **Streaks** — play on consecutive days and it climbs. Rolls over at *local* midnight, which is why `TZ` matters in the compose file.
- **Daily challenge** — one board a day, the same sixteen letters for everyone in the house, generated from the date rather than stored. Four minutes, fixed, so the standings mean something. One *scoring* go each: you can replay it as often as you like and nothing more is banked, which beats telling a seven-year-old no. Because it comes from the date, it is reproducible anywhere and survives losing the database entirely.

  The dictionary is the one thing that is not shared — the unfiltered list is wider, so an adult genuinely has more to find. The standings tag each row with the list it was played on rather than pretending the two are the same.
- **Milestones** — sixteen of them, from "find your first word" to "play thirty days running". Each pays coins.
- **Theme packs** — a pack of words about a subject (Halloween, Minecraft, whatever) that a season can wear. Its words become **valid** so `ENDERMAN` scores, they are **flagged** so finding one fires a celebration and pays **double**, boards are **re-rolled** until they actually contain some, and the accent colour changes to match. Written by pasting a generated prompt into any chatbot and pasting the answer back — no API key, no cost.
- **Seasons** — the arcade boards run on a schedule you set (monthly by default, or any interval, or manual). When a season ends every board is frozen into **badges** and then cleared, so everyone starts level. A badge records the year, season, which board, the rank and the score. Streaks, coins, milestones and lifetime bests are **never** reset — only the walls are. Players get a countdown in the last few days.
- **The arcade board** — three walls (4x4, 5x5, Marathon), ten slots each. You only get to type your initials by beating the tenth score, and when you do, somebody is knocked off for good. Your profile keeps your personal best either way, so missing the wall costs you nothing but the wall.
- **Coins and hints** — earned slowly, spent on a hint that reveals a word still sitting on the board. A hinted word buys you time but scores nothing, so coins can't be converted straight into points.

### What has an interface

| Feature | Server | UI |
|---|---|---|
| Solo / Pass & Play / Tabletop / Own Phones | done | done |
| Marathon | done | done |
| Profiles, streaks, coins, milestones | done | done |
| Hints | done | done |
| Difficulty + longer timers | done | done |
| Arcade board (10 slots, gated entry) | done | done |
| Seasons, badges, hall of fame | done | done |
| Theme packs | done | done |
| Dictionary editing from the browser | done | done |
| Admin: seasons, moderation, profiles | done | done |
| Daily challenge | done | done |

Every feature now has a screen.

What is still outstanding is the classic modes being off the ARKS colour spec
— Marathon, the daily and the profile screens were built to it, the four
original modes were not. `docs/DESIGN.md` lists exactly which values are wrong.

#### A note on theme packs and word length

Measured on 400 random 4x4 boards, a theme word is reachable on:

| Word length | Boards where it can be traced |
|---|---|
| 3–4 letters | about 23% |
| 5–6 letters | about 0.3% |
| 7+ letters | essentially never |

That is geometry, not tuning — an eight-letter word needs a specific eight-cell
path. So a pack of long character names will look wonderful in the admin list
and never once appear in play. The generated prompt demands that two thirds of
the words be 3–5 letters, and the ingest reports the pack's measured
reachability so you can send it back for shorter words.

#### The Rambler API

Everything lives under `/api/rambler`.

| Route | What it does |
|---|---|
| `GET /config` | Sizes, timers, difficulties, milestone catalogue, dictionary stats |
| `POST /board` | Roll a board (`size`, `profile`, `difficulty`) |
| `POST /check` | Validate one word against a board |
| `POST /score` | Score a finished round; pass `playerId` to bank progress |
| `POST /hint` | Spend coins to reveal a word |
| `GET/POST /players`, `GET/PATCH/DELETE /players/:id` | Profiles |
| `GET /daily`, `GET /daily/standings` | The daily board and its table |
| `POST /marathon`, `POST /marathon/:id/word`, `.../hint`, `.../finish` | A Marathon run |
| `POST /rooms`, `.../join`, `.../events`, `.../start`, `.../words`, `.../ready`, `.../next`, `.../leave` | Multi-device rooms; `events` is the SSE stream |
| `GET/POST /leaderboard` | Scores, split by dictionary and board size |

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

## Tests

```bash
npm test
```

Boots a server on port 3222, runs 108 checks across a unit suite (dice, board
shapes, the solver, scoring, streaks, Marathon) and an API suite (every route,
the event stream, the anti-cheat guarantees), then shuts it down. CI runs
exactly this, and publishing to GHCR depends on it passing.

## Running with Docker

```bash
cp .env.example .env   # ADMIN_TOKEN (required for admin), DISCORD_WEBHOOK_URL and ADULT_PIN (both optional)
docker compose up -d --build
```

## Deploying to the homelab

`docker-compose.prod.yml` in this repo is the only file the server needs — it
pulls the image CI built rather than building anything locally:

```bash
mkdir wordless-arcade && cd wordless-arcade
# copy docker-compose.prod.yml here as docker-compose.yml, and .env.example as .env
docker compose pull && docker compose up -d
docker compose ps          # STATUS should read "healthy"
```

The container runs as a non-root user, drops privileges, caps itself at 512MB
(the dictionary trie sits around 120MB resident), and reports unhealthy if the
word lists fail to load rather than merely if the port is open.

Set `TZ` — daily challenges and streaks roll over at local midnight.

## The compose file in full

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
| `ADULT_PIN` | No | Locks Rambler's Unfiltered dictionary behind a PIN. Leave it blank and a confirmation tap is the only thing guarding it, which is fine on a LAN — set it once the server is reachable from outside. |
| `PORT` | No | Defaults to `3000`. |

## Admin panel

Visit `/admin.html` and enter your `ADMIN_TOKEN`. Two tabs.

**Rambler:**
- See the current season, how long is left, and rename it ("Spooky Season")
- Change the reset schedule — every N days/weeks/months, or manual only — and how many days out players get warned
- End a season immediately: freezes every board into badges, then clears them
- Moderate the boards: remove a single entry (for when a child puts something unrepeatable in their three letters) or clear a whole board
- Manage profiles: rename, gift coins, delete
- Hall of fame: every finished season and who won each board
- Theme packs: copy a prompt, paste the answer back, and dress the season in it. The ingest tells you what percentage of boards the pack's words will actually appear on, so you find out immediately if it is all nine-letter names
- Dictionary: add or remove words from the browser. Edits live in the database, not the word files, so they survive a `docker compose pull`

**Wordless:**
- See pending theme requests, with a one-click "Copy Prompt" to paste into an AI chatbot (or use however you like) to generate the theme's word list
- Paste the resulting JSON back in to create the theme and mark the request fulfilled
- Delete custom themes

## Project structure

```
server.js                 Express app, Wordless API routes, mounts the Rambler router
db.js                     SQLite schema for both games, built-in themes, Wordless scoring

rambler/                   Rambler, self-contained
  dice.js                 The real printed die faces, board rolling, path finding
  dictionary.js           Word lists -> one trie, with a profile bitmask per word
  solver.js               Finds every word on a board (~1ms for 4x4)
  scoring.js              Scoring table + duplicate cancellation
  boards.js               Server-side board store, so scoring never trusts the client
  round.js                Board creation, word validation, end-of-round scoring
  rooms.js                In-memory multi-device rooms over Server-Sent Events
  routes.js               Everything under /api/rambler

words/                    Dictionaries, baked into the image (see above)

public/index.html         The arcade hub
public/wordless.html/.js  Wordless
public/rambler.html/.js    Rambler
public/admin.html/.js     Admin panel

Dockerfile
docker-compose.yml
.github/workflows/        CI: builds & publishes the Docker image to GHCR
```
