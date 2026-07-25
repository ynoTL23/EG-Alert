# EG Alert

A tiny Cloudflare Worker that posts the Epic Games Store's weekly free games to a
Discord channel every Thursday at 10:01 AM Eastern.

No dependencies at runtime — just `fetch`, the Epic promotions API, and a Discord
webhook.

## How it works

1. A cron trigger wakes the Worker on Thursday morning.
2. It fetches Epic's free-games promotions feed and keeps only the offers that
   are *actually free right now*.
3. It posts a single embed to your Discord webhook with each game's title, a link
   to its store page, and a countdown to when the giveaway ends.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # then paste your webhook URL into .dev.vars
```

Get a webhook URL from Discord: **Server Settings → Integrations → Webhooks →
New Webhook → Copy Webhook URL**.

## Local development

```sh
npm run dev
```

Then open <http://localhost:8787> in a browser. The `fetch` handler runs the whole
job on demand and posts to Discord, so you don't have to wait for Thursday. It
deliberately skips the schedule guard described below.

To exercise the real cron path instead:

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=1+14+*+*+4"
```

## Deploying

```sh
npm run deploy                   # publish the Worker
npm run secrets                  # set DISCORD_WEBHOOK_URL in production
```

`.dev.vars` is only used locally. Production reads the value from a Wrangler
secret, which is why `npm run secrets` is a separate one-time step.

Cron trigger changes can take up to 15 minutes to propagate across Cloudflare's
network after a deploy.

## About the schedule

Cloudflare cron triggers **run on UTC only** — there is no timezone option, and
UTC does not observe daylight saving. A single cron expression therefore cannot
mean "10:01 Eastern" all year:

| Cron (UTC)     | Summer (EDT, UTC-4) | Winter (EST, UTC-5) |
| -------------- | ------------------- | ------------------- |
| `1 14 * * 4`   | **10:01 AM** ✅     | 9:01 AM             |
| `1 15 * * 4`   | 11:01 AM            | **10:01 AM** ✅     |

So the Worker registers **both**, guaranteeing that one of them always lands on
10:01 Eastern. `shouldSendNow()` in `src/schedule.ts` then checks the real
Eastern wall clock and lets only the correct one through — the other exits
immediately without posting.

The net effect is exactly one Discord post per week, always at 10:01 AM Eastern.
The discarded firing is a no-op that does nothing but check the clock and log.

The send time lives in `src/constants.ts` (`SEND_ZONE`, `SEND_WEEKDAY`,
`SEND_HOUR`). The cron expressions can't be generated from it — Wrangler config
is static JSON — so `npm run check:crons` verifies the two stay in agreement and
prints the correct expressions when they drift. Run `npm run check` (typecheck +
crons) after changing either.

## Project layout

```
src/
  index.ts      entrypoint — cron handler, manual trigger, orchestration
  schedule.ts   when to post, and the Eastern wall-clock guard
  epic.ts       fetches and filters the Epic free-games feed
  discord.ts    builds the embed and posts it to the webhook
  constants.ts  values shared by more than one module (send time, store URL)
  types.ts      shared types (FreeGame)
scripts/
  check-crons.ts  asserts wrangler.jsonc's crons match the send time
wrangler.jsonc  Worker config and cron triggers
.dev.vars       local secrets (gitignored)
```

## Notes

- **Never commit `.dev.vars`.** It holds a webhook URL, which is a bearer
  credential — anyone with it can post to your channel. It is gitignored; if one
  leaks, delete the webhook in Discord and make a new one.
- Epic's feed is quirky in two ways the code works around: `productSlug` is often
  `null` (so store links are built from `catalogNs.mappings[].pageSlug`), and
  `discountPercentage` is the *resulting* percentage, where `0` means free rather
  than "no discount". The price is checked directly instead.
- If Epic lists no free games, the Worker logs and posts nothing rather than
  sending an empty embed.
