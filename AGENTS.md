# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

A single Cloudflare Worker that posts Epic Games Store's weekly free games to a
Discord webhook on a cron trigger. Five source files, no npm dependencies at
runtime, no framework, no tests. It does call three services: Epic's promotions
API, wsrv.nl (image transcoding), and the Discord webhook.

This project does not need a router, a logger, a DI container, or an HTTP client
library. If a change seems to call for one, it is probably the wrong change.

## Commands

```sh
npm run dev           # local server; GET / runs the job immediately
npm run check         # typecheck + lint + format — run after any edit
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (type-aware)
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
npm run format:check  # prettier --check
npm run deploy        # publish to Cloudflare
npm run secrets       # set DISCORD_WEBHOOK_URL in production
```

**Assume `npm run dev` is already running.** Don't start it, and don't start a
second one on another port — Wrangler reloads on save, so edits are already live
at <http://localhost:8787>. To exercise a change, just `curl` it. If the server
turns out not to be running, say so and let the user start it rather than
launching it yourself.

There is no test suite and none is expected. `npm run check` is the check that
matters — run it before declaring work done.

Formatting is Prettier's job and linting is ESLint's; the two don't overlap
(`eslint-config-prettier` turns off the stylistic rules). Don't hand-format code
to match, and don't argue with Prettier — run `npm run format`. `wrangler.jsonc`
is exempt: Prettier would add JSON5 trailing commas to it, so it's in
`.prettierignore` and maintained by hand.

Two type-aware rules are switched off in `eslint.config.js`, each with the
reason inline — `require-await` (the `scheduled` handler uses `ctx.waitUntil`
by design) and `no-unnecessary-type-assertion` (it misreads the `as` on
`res.json()` in `epic.ts`). Both flagged correct code. Read the comment before
re-enabling either.

## Layout

| File               | Responsibility                                          |
| ------------------ | ------------------------------------------------------- |
| `src/index.ts`     | Entrypoint: cron handler, manual trigger, orchestration |
| `src/epic.ts`      | Fetch + filter Epic's promotions feed                   |
| `src/discord.ts`   | Build the embed, POST to the webhook                    |
| `src/webp.ts`      | Build the animated WebP attached to the embed           |
| `src/constants.ts` | Values used by more than one module                     |
| `src/types.ts`     | Types used by more than one module                      |
| `wrangler.jsonc`   | Worker config and cron triggers                         |

Keep fetching, formatting, and dispatch in their own files. `epic.ts` should not
know Discord exists.

`constants.ts` and `types.ts` are for genuinely shared values only — currently
the free-games page URL and `FreeGame`. A constant or type used
in one file stays in that file. Don't turn either into a dumping ground, and
don't add barrel files.

`fetchFreeGames()`, `sendToDiscord()` and `buildSlideshow()` each take a trailing `doFetch` argument
defaulting to the global `fetch`. It exists so both can be exercised against
recorded responses instead of the live network — pass it in tests, omit it
everywhere else. Don't route it through a client object or a DI container.

## Things that will bite you

**One cron, no schedule guard — this is deliberate.** `wrangler.jsonc` registers
exactly `1 16 * * THU`, which is 12:01 PM Eastern in summer and 11:01 AM in
winter. The hour of DST drift is accepted on purpose: Epic rotates the free
games around 11:00 AM Eastern, so aiming at midday clears the rotation on both
sides of the year.

Do not "fix" the drift by adding a second cron and a wall-clock guard. That is
what this repo used to do — two crons (`1 15`, `1 16`) plus `shouldSendNow()` in
a `src/schedule.ts` that no longer exists — and it was removed on purpose once
the send time moved to midday. Pinning the post to an exact local minute is not
a requirement; landing safely after Epic's rotation is.

The failure that motivated this: on 2026-09-03 the 15:01 UTC firing passed the
old guard correctly (it really was 11:01 EDT), fetched Epic, and got an empty
promotions feed — the rotation had not happened yet. The guard was working; the
send time was simply too early.

**Write the cron weekday as `THU`, never as a number.** Cloudflare follows
Quartz numbering, where 1 = Sunday and Thursday is `5` — not the 0 = Sunday
convention most cron systems use. This shipped as `1 14 * * 4` for two weeks,
which is a perfectly valid expression that fires on **Wednesday**. Nothing
validates the crons any more, so check this by hand when editing them.

**Don't lower `compatibility_date` to make `npm run dev` start.** If the date in
`wrangler.jsonc` is newer than the runtime bundled with the installed Wrangler,
the local server refuses to boot:

```
This Worker requires compatibility date "2026-08-13", but the newest date
supported by this server binary is "2026-07-29".
```

Upgrade Wrangler instead (`npm i -D wrangler@latest`). The date reflects the
runtime behaviour the Worker is written against; walking it backwards to satisfy
a stale local binary changes semantics to fix a tooling problem. Deploys are not
affected — Cloudflare's edge runtime is always current.

**The Worker must never decode an image.**
`src/webp.ts` builds the embed's animation by splicing already-encoded WebP
bytes: Epic's CDN resizes, wsrv.nl transcodes, and the Worker only writes RIFF
headers. This is not a stylistic choice. A cron trigger on the free plan gets
**10ms of CPU**, and decoding one JPEG costs 100-300ms. `fetch()` time does not
count toward that budget, which is the only reason this fits. Any change that
decodes, composites, or re-encodes pixels in the Worker will blow the limit.

This rules out a collage. Combining pictures into one frame means writing pixels,
and nothing in the pipeline will do that for us — wsrv.nl transforms one image
per request, and its `overlay`/`mask`/`composite` parameters are silently
ignored. A grid built the only way that _is_ affordable — one frame per tile,
each at its own offset — was tried and reverted: clients with autoplay disabled
render frame 0 and stop, so viewers saw a single tile against black. Hence one
frame per game, each a complete picture.

**Every frame must stand alone.**
GIF/WebP autoplay is a client-side accessibility setting that the API cannot
override, so assume a good share of viewers only ever see frame 0. A frame that
only makes sense after the ones before it is a frame most people never see.

**Epic image URLs need `resize=1`.**
`?w=480` alone is silently ignored — the request falls through to S3 and returns
the full multi-megabyte original. `?resize=1&w=480` hits Akamai and returns a
resized image. `w`+`h` is a bounding box, not a crop, so an aspect ratio that
disagrees with the source comes back the wrong size. `heroCarouselVideo` entries
in `keyImages` carry a `com.epicgames.video://` URL rather than an image.

**`discountPercentage: 0` means free, not "no discount".**
It is the _resulting_ percentage. The code checks
`price.totalPrice.discountPrice === 0` instead, which is unambiguous. Don't
"fix" this to look for `100`.

**`productSlug` is frequently `null`, and `urlSlug` is sometimes a raw hex id.**
Store URLs are built from `catalogNs.mappings[].pageSlug` (falling back to
`offerMappings`), because those are what the storefront actually resolves. A
32-char hex slug is an internal id and will 404. `resolveSlug()` in `src/epic.ts`
handles this — verified against live API data where the featured free game had a
`null` `productSlug`.

**Epic's feed includes games that are not currently free.**
It returns upcoming promotions and unrelated discounts alongside the live
giveaway. Both a live promotional window _and_ a zero price are required.

## Secrets

`DISCORD_WEBHOOK_URL` is a bearer credential — anyone holding it can post to the
channel.

- Local: `.dev.vars` (gitignored). Never commit it, never paste its contents into
  a file, commit message, log line, or PR description.
- Production: a Wrangler secret, set via `npm run secrets`.
- `.dev.vars.example` is the tracked template and must only ever contain
  placeholders.

If a real webhook URL ends up anywhere tracked by git, say so plainly rather than
quietly removing it — it needs to be regenerated in Discord, since rewriting the
file does not un-leak it.

## Conventions

- TypeScript, ES modules, `strict` plus `noUncheckedIndexedAccess`.
- Epic's payload is untrusted input: keep the optional chaining and defensive
  types in `epic.ts` rather than asserting with `!` or `as`.
- Comments should explain _why_ — the API quirks above are the reason most of the
  non-obvious code exists. Don't strip them.
- Failures should be loud in logs but must never post a broken or empty embed to
  Discord.

## Committing

The commit message convention lives in the global `CLAUDE.md`. Repo specifics:

- `npm run check` is the pre-commit check.
- This repo has no test suite, so the commit message is where verification
  evidence lives. Prior commits record mutation checks and hour-by-hour
  comparisons against the old implementation; match that bar for anything
  touching the schedule.
- `origin` is a private GitHub repo (`ynoTL23/EG-Alert`) with issues enabled.
  Reference one in a footer — `Refs: #12`, or `Closes: #12` — when the commit
  resolves it; omit the footer when there is no issue, and never invent a
  number. Push only when asked.
- Never put a real `DISCORD_WEBHOOK_URL` in a commit message — see Secrets
  above.
