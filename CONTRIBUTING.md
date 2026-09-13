# Working on the arcade

Notes to self, mostly.

## Running it

```bash
npm install
npm start          # http://localhost:3000
npm test           # boots a server on 3222 and runs everything
```

`npm test` is the gate. CI runs exactly that, plus a Docker build whose
healthcheck has to go green.

## Layout

- `server.js` — Express app; Wordless routes live here, Rambler is mounted
  from `rambler/routes.js`
- `db.js` — every table for both games, plus the Wordless scoring formula
- `rambler/` — Rambler, self-contained; see the README for what each file does
- `words/` — the dictionaries, plain text, edit by hand
- `test/` — `unit.test.js` needs no server, `api.test.js` needs the one the
  runner starts

## Things that will bite you

- **Boards are rectangular.** Marathon grows the grid, so anything taking a
  board also needs `{ cols, rows }`. A plain number still works and means a
  square.
- **The word-length minimum is fixed when a round is created**, not derived
  from the current board. A growing Marathon board must not start rejecting
  three-letter words halfway through.
- **Rooms must stash their board before broadcasting the start.** Clients begin
  checking words the instant that event lands; publishing first hands them a
  null board id. There is a regression test for this.
- **The server owns every verdict.** Scores are read back from the round the
  server scored, never from the request body. Keep it that way.
- **`node:sqlite` needs Node 22.5+.** It was chosen over `better-sqlite3`
  specifically to keep native build tools out of the Alpine image.

## Releasing

Tag it and CI publishes to GHCR:

```bash
git tag -a v1.1.0 -m "Marathon mode, profiles, daily challenge"
git push origin v1.1.0
```

Then on the homelab: `docker compose pull && docker compose up -d`.
