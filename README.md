# EG Alert

A tiny Cloudflare Worker that posts the Epic Games Store's weekly free games to a
Discord channel every Thursday around midday Eastern.

No dependencies at runtime — just `fetch`, the Epic promotions API, and a Discord
webhook.

## How it works

1. A cron trigger wakes the Worker on Thursday, around midday Eastern.
2. It fetches Epic's free-games promotions feed and keeps only the offers that
   are _actually free right now_.
3. It posts a single embed to your Discord webhook with each game's title, a link
   to its store page, and a countdown to when the giveaway ends.
4. When there is more than one game, it attaches an animated WebP that loops
   through their key art, a second per game. A lone game gets its picture linked
   straight from Epic's CDN instead — there is nothing to animate.

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
job on demand and posts to Discord, so you don't have to wait for Thursday.

To exercise the real cron path instead:

```sh
npm run dev      # passes --test-scheduled, without which /__scheduled
                 # falls through to the fetch handler
npm run trigger
```

The scheduled event's time is the current wall clock, not a time derived from
the `cron=` parameter. Both paths post whenever they are run — there is no
schedule guard.

## Deploying

```sh
npm run deploy                   # publish the Worker
npm run secrets                  # set DISCORD_WEBHOOK_URL in production
```

`.dev.vars` is only used locally. Production reads the value from a Wrangler
secret, which is why `npm run secrets` is a separate one-time step.

Cron trigger changes can take up to 15 minutes to propagate across Cloudflare's
network after a deploy.

`compatibility_date` in `wrangler.jsonc` must not be newer than the runtime
bundled with the installed Wrangler, or `npm run dev` refuses to start:

```
This Worker requires compatibility date "2026-08-13", but the newest date
supported by this server binary is "2026-07-29".
```

The fix is to upgrade Wrangler (`npm i -D wrangler@latest`), not to lower the
date. Deploys are unaffected — this only breaks the local runtime.

## About the schedule

One cron: `1 16 * * THU`.

Cloudflare cron triggers **run on UTC only** — there is no timezone option, and
UTC does not observe daylight saving, so a fixed expression drifts an hour
against Eastern across the year:

| Cron (UTC)     | Summer (EDT, UTC-4) | Winter (EST, UTC-5) |
| -------------- | ------------------- | ------------------- |
| `1 16 * * THU` | 12:01 PM            | 11:01 AM            |

That drift is deliberately tolerated. Epic rotates the free games at roughly
11:00 AM Eastern, and firing at 11:01 raced the rotation — on 2026-09-03 the
Worker woke to an empty promotions feed and posted nothing. Aiming at midday
puts an hour of slack on the summer side and still lands after the rotation in
winter, so neither side of DST needs a correction.

This replaced an earlier arrangement of two crons (`1 15` and `1 16`) plus a
`shouldSendNow()` wall-clock guard that discarded whichever firing was not
11:01 Eastern. That machinery pinned the post to an exact local time; once the
send time moved to midday, the exact local time stopped being worth the
moving parts, and the guard, its constants, and the `check:crons` script were
all removed.

The weekday is written `THU` rather than a number on purpose. Cloudflare follows
[Quartz](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions)
numbering, where **1 = Sunday** and Thursday is `5` — not the `0 = Sunday`
convention most cron systems use. Writing `4` is not an error; it is a valid
expression that fires on **Wednesday**. Nothing checks this any more, so it is
worth getting right by hand.

## Project layout

```
src/
  index.ts      entrypoint — cron handler, manual trigger, orchestration
  epic.ts       fetches and filters the Epic free-games feed
  discord.ts    builds the embed and posts it to the webhook
  webp.ts       builds the looping WebP attached to the embed
  constants.ts  values shared by more than one module (store URL)
  types.ts      shared types (FreeGame)
wrangler.jsonc  Worker config and cron triggers
.dev.vars       local secrets (gitignored)
```

## Notes

- **Never commit `.dev.vars`.** It holds a webhook URL, which is a bearer
  credential — anyone with it can post to your channel. It is gitignored; if one
  leaks, delete the webhook in Discord and make a new one.
- Epic's feed is quirky in two ways the code works around: `productSlug` is often
  `null` (so store links are built from `catalogNs.mappings[].pageSlug`), and
  `discountPercentage` is the _resulting_ percentage, where `0` means free rather
  than "no discount". The price is checked directly instead.
- If Epic lists no free games, the Worker logs and posts nothing rather than
  sending an empty embed.
- The animation is assembled without decoding anything: Epic's CDN resizes each
  picture, [wsrv.nl](https://wsrv.nl) transcodes it to WebP, and the Worker only
  writes the container headers around the frames. A Worker gets very little CPU
  per cron run, and decoding a JPEG would spend it several times over. If
  wsrv.nl is unreachable the post still goes out, just without the animation.
- Epic's image URLs need `?resize=1` for the other parameters to do anything.
  `?w=480` on its own is ignored and returns the multi-megabyte original.
