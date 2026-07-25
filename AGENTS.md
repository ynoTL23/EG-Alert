# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

A single Cloudflare Worker that posts Epic Games Store's weekly free games to a
Discord webhook on a cron trigger. It is intentionally small: four source files,
no runtime dependencies, no framework, no tests.

Keep it that way. This project does not need a router, a logger, a DI container,
or an HTTP client library. If a change seems to call for one, it is probably the
wrong change.

## Commands

```sh
npm run dev        # local server; GET / runs the job immediately
npm run typecheck  # tsc --noEmit — run this after any edit
npm run deploy     # publish to Cloudflare
npm run secrets    # set DISCORD_WEBHOOK_URL in production
```

**Assume `npm run dev` is already running.** Don't start it, and don't start a
second one on another port — Wrangler reloads on save, so edits are already live
at <http://localhost:8787>. To exercise a change, just `curl` it. If the server
turns out not to be running, say so and let the user start it rather than
launching it yourself.

There is no test suite and none is expected. `npm run typecheck` is the check
that matters — run it before declaring work done.

## Layout

| File                | Responsibility                                        |
| ------------------- | ----------------------------------------------------- |
| `src/index.ts`      | Entrypoint: cron handler, manual trigger, orchestration |
| `src/schedule.ts`   | When to post; the Eastern wall-clock guard             |
| `src/epic.ts`       | Fetch + filter Epic's promotions feed                  |
| `src/discord.ts`    | Build the embed, POST to the webhook                   |
| `wrangler.jsonc`    | Worker config and cron triggers                        |

Keep fetching, formatting, and dispatch in their own files. `epic.ts` should not
know Discord exists.

`fetchFreeGames()` and `sendToDiscord()` each take a trailing `doFetch` argument
defaulting to the global `fetch`. It exists so both can be exercised against
recorded responses instead of the live network — pass it in tests, omit it
everywhere else. Don't route it through a client object or a DI container.

## Things that will bite you

**The two crons are deliberate — do not "simplify" them to one.**
Cloudflare crons are UTC-only and UTC has no DST, so no single expression means
"10:01 Eastern" year-round. `wrangler.jsonc` registers both `1 14 * * 4` and
`1 15 * * 4`; `shouldSendNow()` in `src/schedule.ts` discards whichever one is
not 10:01 Eastern today. The constants at the top of that file are the source of
truth for the send time, but the cron expressions must be updated by hand to
match — nothing enforces the pairing. Removing either half breaks a stated
requirement:
drop a cron and it fires at the wrong time for half the year, drop the guard and
it posts twice a week. See the README's schedule section.

**`discountPercentage: 0` means free, not "no discount".**
It is the *resulting* percentage. The code checks
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
giveaway. Both a live promotional window *and* a zero price are required.

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
- Comments should explain *why* — the API quirks above are the reason most of the
  non-obvious code exists. Don't strip them.
- Failures should be loud in logs but must never post a broken or empty embed to
  Discord.
