/**
 * Runs before every routed request (see _routes.json).
 *
 * Its only job is to make sure the project's own plumbing is never served as
 * static content, no matter how the site is uploaded: the Functions source,
 * local tooling files and node_modules are all blocked here. Everything else
 * falls straight through to the matched Function or static asset.
 */

const BLOCKED = [
	"/functions/",
	"/node_modules/",
	"/package.json",
	"/package-lock.json",
	"/.assetsignore",
	"/wrangler.toml",
];

export async function onRequest({ request, next }) {
	const { pathname } = new URL(request.url);
	const path = pathname.toLowerCase();

	if (BLOCKED.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))) {
		return new Response("Not found", {
			status: 404,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	return next();
}
