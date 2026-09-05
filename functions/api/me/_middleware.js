/* Auth gate for /api/me/*: every library route needs a signed-in user.
   The resolved user is passed to handlers via context.data.user. */
import { currentUser, reply } from "../../_lib/auth.js";

export async function onRequest(context) {
	const user = await currentUser(context.request, context.env);
	if (!user) {
		return reply({ ok: false, error: "Not signed in." }, { status: 401 });
	}
	context.data.user = user;
	return context.next();
}
