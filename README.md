# EG Alert

A tiny Cloudflare Worker that posts the Epic Games Store's weekly free games to a
Discord channel every Thursday around midday Eastern.

No dependencies at runtime — just `fetch`, the Epic promotions API, and a Discord
webhook.

## How it works

1. A cron trigger wakes the Worker on Thursday, around midday Eastern.
2. It fetches Epic's free-games promotions feed and keeps only the offers that
   are _actually free right now_.
3. It posts a single embed to your Discord webhook with each game's title and
   usual price, a link to its store page, and a countdown to when the giveaway
   ends. With several games, a "Claim all" button shows what they are worth
   together.
4. It attaches one picture of the week's games, headed "FREE THIS WEEK" and
   the dates, with each game's usual price on its art. Up to five games share
   one collage; six or more become an animation, one frame per game. See
   [About the image](#about-the-image).

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # then paste your webhook URL into .dev.vars
```

Get a webhook URL from Discord: **Server Settings → Integrations → Webhooks →
New Webhook → Copy Webhook URL**. Paste it as-is: the Worker adds the
`with_components` query param itself, which Discord needs to show the
"Claim all" button.

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

One cron: `15 16 * * THU`.

Cloudflare cron triggers **run on UTC only** — there is no timezone option, and
UTC does not observe daylight saving, so a fixed expression drifts an hour
against Eastern across the year:

| Cron (UTC)      | Summer (EDT, UTC-4) | Winter (EST, UTC-5) |
| --------------- | ------------------- | ------------------- |
| `15 16 * * THU` | 12:15 PM            | 11:15 AM            |

That drift is deliberately tolerated. Epic rotates the free games at roughly
11:00 AM Eastern, and firing at 11:01 raced the rotation — on 2026-09-03 the
Worker woke to an empty promotions feed and posted nothing. The rotation follows
Eastern time, so in UTC it moves too: 15:00 in summer, 16:00 in winter. An
interim `1 16` cron assumed a fixed 15:00 UTC and raced the winter rotation on
2026-11-26. `15 16` lands 15 minutes after the winter rotation and 75 after the
summer one, so neither side needs a correction.

This replaced an earlier arrangement of two crons (`1 15` and `1 16`) plus a
`shouldSendNow()` wall-clock guard that discarded whichever firing was not
11:01 Eastern. That machinery pinned the post to an exact local time; once the
send time moved to midday, the exact local time stopped being worth the
moving parts, and the guard, its constants, and the `check:crons` script were
all removed. A smaller `check:crons` came back after 2026-11-26: it checks the
one cron against the winter rotation instead of against a local send time.

The weekday is written `THU` rather than a number on purpose. Cloudflare follows
[Quartz](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions)
numbering, where **1 = Sunday** and Thursday is `5` — not the `0 = Sunday`
convention most cron systems use. Writing `4` is not an error; it is a valid
expression that fires on **Wednesday**. `npm run check:crons` rejects anything
but `THU`, and fails when the cron lands under 10 minutes after the winter
rotation.

## About the image

Discord shows an embed image in a 400x225 box on desktop, so every picture is
16:9 and every label is sized to stay readable at that size: the 1600x900
collage shrinks to a quarter, the 800x450 slideshow frames to half. Clicking the
image opens it full size.

| Games | Picture                                              |
| ----- | ---------------------------------------------------- |
| 1     | The game's art, full frame                           |
| 2     | Two halves side by side                              |
| 3     | One large tile, two 16:9 tiles stacked beside it     |
| 4     | A 2x2 grid                                           |
| 5     | Five slices leaning `/`                              |
| 6+    | An animation, one complete frame per game, 1.5s each |

Every picture carries the same labels:

- **A headline chip and a date chip**, joined, top-left: "FREE THIS WEEK" in
  white on Epic blue, then "NOV 26 – DEC 3" in black on white. The dates run
  from the earliest start to the earliest end among the games, so they never
  promise a game is free for longer than it is.
- **A price tag per game**, the usual price in black on white, bottom-left of
  each tile (bottom-right of each slice). A game Epic lists without a price gets
  no tag. "FREE" on every game was tried and dropped: saying it once in the
  headline is the point of the post.
- **A black outline on every label**, so a blue or white chip still has an edge
  on blue or white art. A drop shadow lost its top and left edges on matching
  colours; an outline doesn't.

The labels are set in [Saira Condensed](https://fonts.google.com/specimen/Saira+Condensed),
loaded from [Fontsource](https://fontsource.org) on jsdelivr each run and pinned
to one version. It was picked from sixteen Google Fonts compared at the same
cap height, ruling out faces that run wide (Archivo Black, Inter) or tall and
narrow (League Gothic).

Each slideshow frame repeats the headline and its game's price, because a
viewer with autoplay turned off only ever sees the first frame.

Everything is drawn by the Cloudflare Images binding, never in the Worker: a run
costs 2-4 transformations for a collage, or one per game for a slideshow, plus
one for measuring the headline. If any of it fails — Epic's CDN, the font, or
the binding past its 5,000-a-month free tier — the post still goes out, with
Epic's own picture of the first game.

## Project layout

```
src/
  index.ts      entrypoint — cron handler, manual trigger, orchestration
  epic.ts       fetches and filters the Epic free-games feed
  discord.ts    builds the embed and posts it to the webhook
  webp.ts       builds the WebP attached to the embed, splices animations
  collage.ts    draws the collage and slideshow frames in the Images binding
  webp.test.ts  tests buildImage() against a fake Images binding
  constants.ts  values shared by more than one module (store URL, prices)
  types.ts      shared types (FreeGame)
scripts/
  check-crons.ts  fails when the cron can race Epic's rotation
wrangler.jsonc  Worker config and cron triggers
.dev.vars       local secrets (gitignored)
```

## Notes

- **Never commit `.dev.vars`.** It holds a webhook URL, which is a bearer
  credential — anyone with it can post to your channel. It is gitignored; if one
  leaks, delete the webhook in Discord and make a new one.
- Epic's feed is quirky in ways the code works around: `productSlug` is often
  `null` (so store links are built from `catalogNs.mappings[].pageSlug`), and
  `discountPercentage` is the _resulting_ percentage, where `0` means free rather
  than "no discount". The price is checked directly instead.
- Some giveaways have no list price in Epic's feed (it says `0`). Those post
  without a price, and a week with one of them shows no "Claim all" total, which
  appears only when every game is priced.
- If Epic lists no free games, the Worker posts nothing rather than sending an
  empty embed. It logs an error, plus a warning that summarises the feed and
  says whether the copy it got was stale.
- The image is assembled without decoding anything: Epic's CDN resizes each
  picture, the [Cloudflare Images](https://developers.cloudflare.com/images/optimization/binding/)
  binding draws the tiles and labels, and the Worker only writes the container
  headers around animation frames. A Worker gets very little CPU per cron run,
  and decoding a JPEG would spend it several times over. If a transform fails —
  including past the Images Free plan's 5,000 a month — the post still goes
  out, with Epic's picture of the first game instead.
- Epic's image URLs need `?resize=1` for the other parameters to do anything.
  `?w=480` on its own is ignored and returns the multi-megabyte original.
