/* GET /api/me/approvals/wait - long poll for sign-ins awaiting an answer.
 *
 * The plain /api/me/approvals is a snapshot; this one holds the connection open
 * and answers the moment something appears, so a request reaches the device in
 * about a second instead of whenever the next poll happens to run. One held
 * connection per open tab replaces a steady stream of requests.
 *
 * It gives up after WINDOW seconds and expects the client to ask again, which
 * keeps it well inside any proxy or platform timeout.
 */
import { listPendingApprovals, reply } from "../../../_lib/auth.js";

const WINDOW = 25000;                  // hold for at most 25s
const STEP = 1000;                     // check the table this often

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shape(rows, now) {
	return rows.map((row) => ({
		id: row.id,
		device: row.device || "Computer",
		os: row.os || "",
		browser: row.browser || "",
		location: row.location || "",
		ip: row.ip || "",
		created_at: row.created_at,
		expires_in: Math.max(0, row.expires_at - now),
	}));
}

export async function onRequestGet({ request, env, data }) {
	const deadline = Date.now() + WINDOW;

	while (true) {
		let rows;
		try {
			rows = await listPendingApprovals(env, data.user.id);
		} catch (e) {
			// Table not migrated yet: nothing can be waiting.
			return reply({ ok: true, approvals: [], unavailable: true });
		}
		if (rows.length) {
			return reply({ ok: true, approvals: shape(rows, Math.floor(Date.now() / 1000)) });
		}
		// The client navigated away or gave up: stop burning reads for it.
		if (request.signal && request.signal.aborted) return reply({ ok: true, approvals: [] });
		if (Date.now() + STEP >= deadline) break;
		await sleep(STEP);
	}

	return reply({ ok: true, approvals: [], timeout: true });
}
