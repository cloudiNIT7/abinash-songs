/* Auth gate for /api/me/*: every library route needs a signed-in user.
   The resolved user is passed to handlers via context.data.user. */
import { currentUser, reply } from "../../_lib/auth.js";

export async function onRequest(context) {
	// waitUntil keeps the session's "last active" write off the response path.
	const user = await currentUser(
		context.request,
		context.env,
		context.waitUntil && context.waitUntil.bind(context),
	);
	if (!user) {
		return reply({ ok: false, error: "Not signed in." }, { status: 401 });
	}
	context.data.user = user;
	return context.next();
}
