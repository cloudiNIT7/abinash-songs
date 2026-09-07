/**
 * Local checks for the APNs wiring in functions/_lib/push.js: the token store,
 * the approval fan-out and the suggestion nudge. D1 and fetch are both stubbed,
 * so nothing here touches a database or Apple.
 *
 *   node ios/tools/push-selftest.mjs
 */
import { generateKeyPairSync } from "node:crypto";
import {
	saveApnsToken, deleteApnsToken, listApnsTokens, apnsToUser, suggestToUser, pushToUser,
} from "../../functions/_lib/push.js";

let failures = 0;
function check(name, condition, extra = "") {
	if (condition) {
		console.log("  ok   " + name);
	} else {
		failures++;
		console.log("  FAIL " + name + (extra ? " :: " + extra : ""));
	}
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const DEVICE = "b".repeat(64);
const USER = "user-1";

/** A D1 stand-in that records statements and answers SELECTs from a fixture. */
function fakeDB(rowsFor = {}) {
	const statements = [];
	const db = {
		statements,
		prepare(sql) {
			const entry = { sql: sql.replace(/\s+/g, " ").trim(), binds: [] };
			return {
				bind(...binds) {
					entry.binds = binds;
					return this;
				},
				async run() {
					statements.push(entry);
					return { success: true };
				},
				async all() {
					statements.push(entry);
					const key = Object.keys(rowsFor).find((k) => entry.sql.includes(k));
					return { results: key ? rowsFor[key] : [] };
				},
			};
		},
	};
	return db;
}

const apnsEnv = () => ({
	APNS_KEY: pem,
	APNS_KEY_ID: "ABCDE12345",
	APNS_TEAM_ID: "TEAM123456",
});

let calls = [];
function stubFetch(status = 200, reason = "") {
	calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		return { status, json: async () => (reason ? { reason } : {}) };
	};
}

console.log("token store");
{
	const env = Object.assign(apnsEnv(), { DB: fakeDB() });
	const request = { headers: { get: () => "CloudSongs/1.2.1 (iOS)" } };
	await saveApnsToken(env, USER, DEVICE, { environment: "sandbox" }, request);
	const insert = env.DB.statements[0];
	check("insert targets apns_tokens", /INSERT INTO apns_tokens/.test(insert.sql), insert.sql);
	check("upsert on conflict", /ON CONFLICT\(token\) DO UPDATE/.test(insert.sql));
	check("six bound values", insert.binds.length === 6, JSON.stringify(insert.binds.length));
	check("token, user and environment bound", insert.binds[0] === DEVICE && insert.binds[1] === USER && insert.binds[2] === "sandbox");
	check("user agent recorded", insert.binds[3] === "CloudSongs/1.2.1 (iOS)");

	await deleteApnsToken(env, USER, DEVICE);
	const del = env.DB.statements[1];
	check("delete is scoped to the account", /DELETE FROM apns_tokens WHERE token = \? AND user_id = \?/.test(del.sql), del.sql);
}

console.log("token list");
{
	const env = Object.assign(apnsEnv(), {
		DB: fakeDB({ "FROM apns_tokens": [{ token: DEVICE, env: "sandbox" }, { token: "c".repeat(64), env: null }] }),
	});
	const rows = await listApnsTokens(env, USER);
	check("rows are {token, env}", rows.length === 2 && rows[0].token === DEVICE && rows[0].env === "sandbox");
	check("missing env defaults to production", rows[1].env === "production");
}

console.log("approval fan-out");
{
	const env = Object.assign(apnsEnv(), { DB: fakeDB({ "FROM apns_tokens": [{ token: DEVICE, env: "sandbox" }] }) });
	stubFetch(200);
	const out = await apnsToUser(env, USER, { topic: "cs-approval" });
	check("one push sent", out.sent === 1 && out.gone === 0, JSON.stringify(out));
	check("sandbox host for a sandbox token", calls[0].url.startsWith("https://api.sandbox.push.apple.com/"), calls[0].url);
	check("generic wording only", calls[0].body.aps.alert.title === "Approve sign-in to Cloud Songs?");
	check("kind=approval rides along", calls[0].body.kind === "approval");
	check("collapsed as cs-approval", calls[0].headers["apns-collapse-id"] === "cs-approval");
}

console.log("dead token is dropped");
{
	const env = Object.assign(apnsEnv(), { DB: fakeDB({ "FROM apns_tokens": [{ token: DEVICE, env: "production" }] }) });
	stubFetch(410, "Unregistered");
	const out = await apnsToUser(env, USER, {});
	check("reported as gone", out.gone === 1, JSON.stringify(out));
	check("row deleted", env.DB.statements.some((s) => /DELETE FROM apns_tokens WHERE token = \? AND user_id = \?$/.test(s.sql)), JSON.stringify(env.DB.statements.map((s) => s.sql)));
	check("delete is bound to the account", env.DB.statements.some((s) => /DELETE FROM apns_tokens/.test(s.sql) && s.binds[1] === USER));
}

console.log("suggestions");
{
	const env = Object.assign(apnsEnv(), { DB: fakeDB({ "FROM apns_tokens": [{ token: DEVICE, env: "production" }] }) });
	stubFetch(200);
	const out = await suggestToUser(env, USER, {
		title: "Rain outside",
		body: "Something slow for it - Tum Hi Ho",
		song: { id: "abc123", name: "Tum Hi Ho", image: "https://c.saavncdn.com/x-500x500.jpg" },
	});
	check("counted as sent", out.sent === 1 && out.apns === 1 && out.fcm === 0, JSON.stringify(out));
	check("title and body carried", calls[0].body.aps.alert.title === "Rain outside" && calls[0].body.aps.alert.body.includes("Tum Hi Ho"));
	check("song id in the payload", calls[0].body.songId === "abc123");
	check("album art for the extension", calls[0].body.image === "https://c.saavncdn.com/x-500x500.jpg");
	check("collapsed as cs-suggest", calls[0].headers["apns-collapse-id"] === "cs-suggest");
}

console.log("no APNs configured");
{
	const env = { DB: fakeDB({ "FROM apns_tokens": [{ token: DEVICE, env: "production" }] }) };
	stubFetch(200);
	const out = await apnsToUser(env, USER, {});
	check("nothing sent, nothing thrown", out.sent === 0 && calls.length === 0, JSON.stringify(out));
	const sug = await suggestToUser(env, USER, { song: { id: "x" } });
	check("suggestions are a no-op too", sug.sent === 0, JSON.stringify(sug));
}

console.log("table not migrated yet");
{
	const env = Object.assign(apnsEnv(), {
		DB: { prepare() { throw new Error("no such table: apns_tokens"); } },
	});
	stubFetch(200);
	let threw = false;
	try {
		const out = await apnsToUser(env, USER, {});
		check("degrades to zero sends", out.sent === 0, JSON.stringify(out));
	} catch (e) {
		threw = true;
	}
	check("never throws at the caller", threw === false);
}

console.log("login path reaches every transport");
{
	const env = Object.assign(apnsEnv(), {
		DB: fakeDB({ "FROM apns_tokens": [{ token: DEVICE, env: "production" }] }),
	});
	stubFetch(200);
	const out = await pushToUser(env, USER, { topic: "cs-approval" });
	check("iOS device counted in pushToUser", out.sent === 1, JSON.stringify(out));
	check("web push not attempted without subscriptions", calls.length === 1);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
