# JevBot operations

Run Pokémon Showdown separately when using local mode.

## Prerequisites

- Deno 2.9 or newer
- A local Pokémon Showdown checkout for local mode
- An `OPENROUTER_API_KEY` for Jev decisions

```sh
cp .env.example .env
```

Deno downloads dependencies on the first run.

## Run modes

| Command                                     | Server                                    | Identity                                |
| ------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| `deno task --env-file=.env jevbot:local`    | `ws://127.0.0.1:8000/showdown/websocket`  | `BOT_NAME`, or `JevBot` by default      |
| `deno task --env-file=.env jevbot`          | Follows `PS_LIVE` and other `.env` values | `BOT_NAME` locally; `PS_USERNAME` live  |
| `deno task --env-file=.env jevbot:live`     | Official secure WebSocket                 | `PS_USERNAME`                           |
| `deno task --env-file=.env jevbot:parallel` | Official secure WebSocket                 | `PS_USERNAME`; up to five games at once |

The local and live commands override `PS_LIVE`. Use `--env-file=.env` to load
the file.

## Local development battle

Start a local Pokémon Showdown server, then run:

```sh
deno task --env-file=.env jevbot:local
```

Open `http://localhost:8000`, choose a name, select **Gen 9 Random Battle**, and
queue.

## Live mode

Fill the live values in `.env`:

```dotenv
PS_LIVE=1
PS_USERNAME=YOUR_BOT_ACCOUNT
PS_PASSWORD=YOUR_PASSWORD
OPENROUTER_API_KEY=YOUR_OPENROUTER_KEY
```

Then run:

```sh
deno task --env-file=.env jevbot:live
```

### Ladder runs

Play a fixed number of games:

```sh
deno task --env-file=.env jevbot:ladder --games 20
```

Or use up to five parallel games:

```sh
deno task --env-file=.env jevbot:parallel --games 20
```

Runs are written to `logs/jevbot/run-*/`.

`PS_LIVE=1` uses `wss://sim3.psim.us/showdown/websocket` by default. Set
`PS_URL` to use a different endpoint.

## Configuration

```dotenv
# Optional local display name; only used outside live mode.
BOT_NAME=JevBot

# OpenRouter / Jev
OPENROUTER_API_KEY=
JEV_MODEL=typesafe/jev-1.13
JEV_TIMEOUT_MS=5000
JEV_DEBUG=0

# Recording
BOT_RECORD=1
BOT_LOG_DIR=logs/jevbot
```

`JEV_DEBUG=1` prints the Jev request state.

## Recordings

Recording writes JSONL files to `logs/jevbot/<battle-room>.jsonl`:

- `battle_start`
- `public_event`
- `decision` (when Jev is enabled)
- `battle_end`

Decision records include the request state, action, response, usage, latency,
and fallback reason.

## Audit

Set `DEEPSEEK_API_KEY` in `.env`, then audit a run:

```sh
deno task --env-file=.env audit --run logs/jevbot/run-2026-09-30T10-00-00-000Z
```

Or audit the newest `logs/jevbot/run-*` directory:

```sh
deno task --env-file=.env audit --latest
```

Reviews are saved in the run's `audit/` directory and the report is `audit.md`.

## Tests

```sh
deno task test
```

Run the live Jev check with an OpenRouter key:

```sh
deno task --env-file=.env test:live
```
