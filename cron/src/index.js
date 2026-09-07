/**
 * Scheduled nudger.
 *
 * Cloudflare Pages Functions cannot be scheduled - cron triggers are a Workers
 * feature - so this tiny Worker exists purely to call the Pages endpoint on a
 * timer. All of the actual logic (who is eligible, quiet hours, daily caps, the
 * copy, the weather) lives in the Pages Function, so this file should not need
 * to change.
 *
 * It runs every two hours; the endpoint itself decides that most accounts are
 * not due, which is what keeps the nudges occasional rather than hourly.
 */
export default {
	async scheduled(event, env, ctx) {
		ctx.waitUntil(run(env));
	},

	// Manual trigger for testing: GET / with the same secret.
	async fetch(request, env) {
		const given = request.headers.get("X-Cron-Secret") || "";
		if (!env.CRON_SECRET || given !== env.CRON_SECRET) {
			return new Response("Not authorised.", { status: 401 });
		}
		const body = await run(env, new URL(request.url).searchParams.get("dry") === "1");
		return new Response(body, { headers: { "Content-Type": "application/json" } });
	},
};

async function run(env, dry) {
	const base = env.SITE_ORIGIN || "https://abinash-songs.pages.dev";
	const url = base + "/api/cron/suggest" + (dry ? "?dry=1" : "");
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "X-Cron-Secret": env.CRON_SECRET || "" },
		});
		const text = await res.text();
		console.log("suggest run:", res.status, text.slice(0, 400));
		return text;
	} catch (e) {
		console.log("suggest run failed:", e && e.message);
		return JSON.stringify({ ok: false, error: String(e && e.message) });
	}
}
