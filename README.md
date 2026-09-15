# ai-news-feed

Daily AI news digest (developers + education) delivered to Telegram by
`@ayaz_feeds_bot`.

## How it runs

GitHub Actions, `.github/workflows/digest.yml`, daily at 06:32 UTC. Dedupe
state lives in `seen.json`, which the workflow commits back after each run.

## Running locally

```sh
bun run feed.ts --dry   # print the digest, send nothing
bun run feed.ts         # send it
```

Local runs read `.env` (gitignored):

```
FEEDS_BOT_TOKEN=...
FEEDS_CHAT_ID=...
```

Note that a local send marks items seen only in your local `seen.json`, so it
will not stop the cloud job resending them. Prefer `--dry` locally.

## Configuration

`feeds.json` — sources, AI keyword list, recency window, item cap.
Sources tagged `education` are reserved 4 slots so the higher-volume `dev`
feeds cannot crowd them out.

`filter: true` means the source is general-interest and its headlines must
match a keyword; `false` means the whole feed is already on-topic.

## Bot

`@ayaz_feeds_bot` is push-only and deliberately separate from the Claude Code
control bot. Its token is expected to live in CI secrets; the control bot's
token never does.
