# JevBot

JevBot is a Gen 9 Random Battle client for Pokémon Showdown. It uses TypeSafe
Jev on OpenRouter to choose from legal moves, Tera moves, and switches.

## Quick start

```sh
cp .env.example .env
deno task --env-file=.env jevbot:local
```

Start a local Pokémon Showdown server separately, then queue a Gen 9 Random
Battle in its browser client.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for configuration and commands.

## Dependency

`pokemon-showdown` provides simulator mechanics and Random Battle set data.
