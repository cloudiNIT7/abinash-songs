/**
 * Local checks for functions/_lib/apns.js - the provider JWT and the request it
 * builds - with fetch stubbed out. Nothing here talks to Apple.
 *
 *   node ios/tools/apns-selftest.mjs
 */
import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { sendApns, apnsAvailable, apnsTopic, signProviderToken } from "../../functions/_lib/apns.js";

let failures = 0;
function check(name, condition, extra = "") {
	if (condition) {
		console.log("  ok   " + name);
	} else {
		failures++;
		console.log("  FAIL " + name + (extra ? " :: " + extra : ""));
	}
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const env = {
	APNS_KEY: pem,
	APNS_KEY_ID: "ABCDE12345",
	APNS_TEAM_ID: "TEAM123456",
	APNS_BUNDLE_ID: "com.cloudsongs.app",
};
const creds = { key: pem, keyId: "ABCDE12345", teamId: "TEAM123456", bundleId: "com.cloudsongs.app" };
const DEVICE = "a".repeat(64);

function b64urlToBuffer(text) {
	return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

console.log("configuration");
check("available with a key configured", apnsAvailable(env) === true);
check("unavailable without one", apnsAvailable({}) === false);
check("topic is the bundle id", apnsTopic(env) === "com.cloudsongs.app");
check("topic falls back to com.cloudsongs.app", apnsTopic({}) === "com.cloudsongs.app");

console.log("provider token");
const jwt = await signProviderToken(creds, 1700000000);
const [h, c, s] = jwt.split(".");
const header = JSON.parse(b64urlToBuffer(h).toString());
const claims = JSON.parse(b64urlToBuffer(c).toString());
check("ES256 header with kid", header.alg === "ES256" && header.kid === "ABCDE12345", JSON.stringify(header));
check("iss is the team id", claims.iss === "TEAM123456", JSON.stringify(claims));
check("iat is the given time", claims.iat === 1700000000);
check(
	"signature verifies as raw r||s ES256",
	verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, b64urlToBuffer(s)) === true,
);
check("key is a usable pkcs8 P-256 key", createPrivateKey(pem).asymmetricKeyType === "ec");

/* ---------- request shape ---------- */

let calls = [];
function stubFetch(responder) {
	calls = [];
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, headers: init.headers, body });
		return responder(calls.length, url);
	};
}
const ok = () => ({ status: 200, json: async () => ({}) });
const rejected = (status, reason) => ({ status, json: async () => ({ reason }) });

console.log("alert push");
stubFetch(ok);
let state = await sendApns(env, DEVICE, {
	title: "Approve sign-in to Cloud Songs?",
	body: "Someone signed in with your password. Tap to review.",
	collapseId: "cs-approval",
	threadId: "cs-approval",
	image: "https://abinash-songs.pages.dev/assets/pwa-512.png",
	data: { kind: "approval", topic: "cs-approval" },
});
let call = calls[0];
check("state is sent on 200", state === "sent");
check("production host by default", call.url.startsWith("https://api.push.apple.com/3/device/"), call.url);
check("device token in the path", call.url.endsWith("/" + DEVICE));
check("bearer provider token", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(call.headers.authorization));
check("apns-topic is the bundle id", call.headers["apns-topic"] === "com.cloudsongs.app");
check("push type alert", call.headers["apns-push-type"] === "alert");
check("priority 10", call.headers["apns-priority"] === "10");
check("collapse id set", call.headers["apns-collapse-id"] === "cs-approval");
check("alert title/body", call.body.aps.alert.title.startsWith("Approve sign-in") && call.body.aps.alert.body.includes("Tap to review"));
check("mutable-content so the extension can add art", call.body.aps["mutable-content"] === 1);
check("thread id", call.body.aps["thread-id"] === "cs-approval");
check("image passed through for the extension", call.body.image.endsWith("/assets/pwa-512.png"));
check("custom data merged", call.body.kind === "approval" && call.body.topic === "cs-approval");
check("no account data in the payload", !JSON.stringify(call.body).match(/\b(ip|city|device|email)\b/i), JSON.stringify(call.body));

console.log("silent push");
stubFetch(ok);
state = await sendApns(env, DEVICE, { silent: true, data: { kind: "approval" } });
call = calls[0];
check("state is sent", state === "sent");
check("content-available", call.body.aps["content-available"] === 1);
check("no alert", call.body.aps.alert === undefined);
check("push type background", call.headers["apns-push-type"] === "background");
check("priority 5", call.headers["apns-priority"] === "5");

console.log("sandbox environment");
stubFetch(ok);
await sendApns(env, DEVICE, { title: "x", environment: "sandbox" });
check("sandbox host used", calls[0].url.startsWith("https://api.sandbox.push.apple.com/"), calls[0].url);

console.log("dead tokens");
stubFetch(() => rejected(410, "Unregistered"));
check("410 is gone", (await sendApns(env, DEVICE, { title: "x" })) === "gone");

stubFetch(() => rejected(403, "InvalidProviderToken"));
check("403 is failed, token kept", (await sendApns(env, DEVICE, { title: "x" })) === "failed");

stubFetch((n) => (n === 1 ? rejected(400, "BadDeviceToken") : ok()));
state = await sendApns(env, DEVICE, { title: "x", environment: "production" });
check("BadDeviceToken retries the other host", calls.length === 2 && calls[1].url.startsWith("https://api.sandbox.push.apple.com/"), JSON.stringify(calls.map((x) => x.url)));
check("and reports the retry's result", state === "sent");

stubFetch((n) => rejected(400, "BadDeviceToken"));
check("still gone when both hosts reject", (await sendApns(env, DEVICE, { title: "x" })) === "gone");

console.log("no credentials");
stubFetch(ok);
check("send is a no-op without a key", (await sendApns({}, DEVICE, { title: "x" })) === "failed" && calls.length === 0);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
