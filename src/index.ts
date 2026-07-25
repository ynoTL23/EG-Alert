import { fetchFreeGames } from "./epic.js";
import { sendToDiscord } from "./discord.js";

export interface Env {
  DISCORD_WEBHOOK_URL: string;
}

/**
 * We register two UTC crons (14:01 and 15:01 Thursday) so that one of them
 * always lands on 10:01 Eastern regardless of daylight saving. This checks
 * the actual Eastern wall clock and lets only the correct one through, so
 * we never post twice.
 */
function isEasternSendTime(date: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;

  return get("weekday") === "Thu" && get("hour") === "10";
}

async function run(env: Env, now: Date): Promise<Response> {
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error(
      "DISCORD_WEBHOOK_URL is not set. Add it to .dev.vars locally, or run `npm run secrets` to set it in production.",
    );
  }

  const games = await fetchFreeGames(now);

  if (games.length === 0) {
    console.log("No free games currently listed; skipping Discord post.");
    return new Response("No free games found.", { status: 200 });
  }

  await sendToDiscord(env.DISCORD_WEBHOOK_URL, games);

  const titles = games.map((g) => g.title).join(", ");
  console.log(`Posted ${games.length} free game(s): ${titles}`);
  return new Response(`Posted: ${titles}`, { status: 200 });
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = new Date(event.scheduledTime);

    if (!isEasternSendTime(now)) {
      console.log(
        `Skipping cron ${event.cron}: not 10:00 Eastern (DST guard).`,
      );
      return;
    }

    ctx.waitUntil(
      run(env, now).catch((err) => {
        console.error("Scheduled run failed:", err);
        throw err;
      }),
    );
  },

  /**
   * Manual trigger for testing — visit the worker URL to force a post
   * without waiting for Thursday. The DST guard is deliberately skipped here.
   */
  async fetch(_req: Request, env: Env): Promise<Response> {
    try {
      return await run(env, new Date());
    } catch (err) {
      console.error("Manual run failed:", err);
      return new Response(`Error: ${(err as Error).message}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
