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
npm run dev           # local server; GET / runs the job immediately
npm run check         # typecheck + crons + lint + format — run after any edit
npm run typecheck     # tsc --noEmit
npm run check:crons   # assert wrangler.jsonc crons match SEND_* in constants.ts
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

| File                     | Responsibility                                          |
| ------------------------ | ------------------------------------------------------- |
| `src/index.ts`           | Entrypoint: cron handler, manual trigger, orchestration |
| `src/schedule.ts`        | When to post; the Eastern wall-clock guard              |
| `src/epic.ts`            | Fetch + filter Epic's promotions feed                   |
| `src/discord.ts`         | Build the embed, POST to the webhook                    |
| `src/constants.ts`       | Values used by more than one module                     |
| `src/types.ts`           | Types used by more than one module                      |
| `scripts/check-crons.ts` | Asserts the crons match the send time                   |
| `wrangler.jsonc`         | Worker config and cron triggers                         |

Keep fetching, formatting, and dispatch in their own files. `epic.ts` should not
know Discord exists.

`constants.ts` and `types.ts` are for genuinely shared values only — currently
the send time, the free-games page URL, and `FreeGame`. A constant or type used
in one file stays in that file. Don't turn either into a dumping ground, and
don't add barrel files.

`fetchFreeGames()` and `sendToDiscord()` each take a trailing `doFetch` argument
defaulting to the global `fetch`. It exists so both can be exercised against
recorded responses instead of the live network — pass it in tests, omit it
everywhere else. Don't route it through a client object or a DI container.

## Things that will bite you

**The two crons are deliberate — do not "simplify" them to one.**
Cloudflare crons are UTC-only and UTC has no DST, so no single expression means
"10:01 Eastern" year-round. `wrangler.jsonc` registers both `1 14 * * 4` and
`1 15 * * 4`; `shouldSendNow()` in `src/schedule.ts` discards whichever one is
not 10:01 Eastern today. Removing either half breaks a stated requirement: drop a
cron and it fires at the wrong time for half the year, drop the guard and it
posts twice a week. See the README's schedule section.

`SEND_ZONE`/`SEND_WEEKDAY`/`SEND_HOUR` in `src/constants.ts` are the source of
truth for the send time. The cron expressions still have to be edited by hand —
Wrangler config is static JSON and can't import them — but `npm run check:crons`
now fails when the two disagree and prints the expressions you should have. If
you change the send time, change both and run it.

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

Run `npm run check` before committing. Commit only what the change touches —
don't sweep unrelated edits in.

Follow [Conventional Commits](https://www.conventionalcommits.org/): a
`type(scope): subject` line, imperative mood, lowercase, no trailing period,
kept to 72 characters or fewer. Types in use here are `feat`, `fix`, `refactor`,
`docs` and `chore`. The scope is optional and is a source path without the
extension — `schedule`, `epic,discord`, `scripts`, `agents` — omit it when the
change is repo-wide. Breaking changes get a `!` before the colon and a
`BREAKING CHANGE:` footer.

Add a body whenever the subject line leaves a "why" unanswered — which is most
non-trivial commits. Blank line after the subject, hard-wrapped at 80 columns
like the existing history, and write prose, not a restated diff. Cover
whichever of these apply:

- What was wrong or missing before, and why it mattered.
- Why this approach over the obvious alternative, and what it trades away.
- How the change was verified — this repo has no test suite, so the commit
  message is where evidence lives. Prior commits record mutation checks and
  hour-by-hour comparisons against the old implementation; match that bar for
  anything touching the schedule.
- What was deliberately left alone, when a reader would expect it to change.

A one-line commit is fine when the subject genuinely says everything: a typo
fix, a version bump, a rename.

Reference a GitHub issue in a footer, not the subject: `Refs: #12`, or
`Closes: #12` when the commit resolves it. There is currently no remote and no
issue tracker, so omit this unless the user gives you an issue number.

Never put a real `DISCORD_WEBHOOK_URL` in a commit message — see Secrets above.
