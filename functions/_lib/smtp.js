/**
 * Tiny SMTP client for Cloudflare Pages Functions.
 *
 * The Workers runtime has no nodemailer and no raw Node sockets, but it does
 * expose `connect()` from "cloudflare:sockets". We open an implicit-TLS
 * connection to Gmail on port 465 and speak just enough SMTP to send one
 * message: EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA.
 *
 * Credentials come from project secrets, never from source:
 *   SMTP_USER  - the Gmail address
 *   SMTP_PASS  - a Gmail App Password (spaces are ignored)
 *   SMTP_FROM_NAME (optional) - display name, defaults to "Cloud Songs"
 *   SMTP_HOST / SMTP_PORT (optional) - default smtp.gmail.com:465
 */
import { connect } from "cloudflare:sockets";

const CRLF = "\r\n";

function b64(str) {
	// btoa needs a binary string; SMTP creds are ASCII so this is safe.
	return btoa(unescape(encodeURIComponent(str)));
}

class SmtpSession {
	constructor(socket) {
		this.socket = socket;
		this.writer = socket.writable.getWriter();
		this.reader = socket.readable.getReader();
		this.enc = new TextEncoder();
		this.dec = new TextDecoder();
		this.buffer = "";
	}

	async send(line) {
		await this.writer.write(this.enc.encode(line + CRLF));
	}

	/** Read one full SMTP reply (handles multi-line 250- continuations). */
	async read(expectPrefixes) {
		while (true) {
			// A complete reply ends with a line "NNN <text>" (space after code).
			const lines = this.buffer.split(CRLF).filter(Boolean);
			const last = lines[lines.length - 1];
			if (last && /^\d{3} /.test(last)) {
				const code = last.slice(0, 3);
				const reply = this.buffer.trim();
				this.buffer = "";
				if (expectPrefixes && !expectPrefixes.some((p) => code.startsWith(p))) {
					throw new Error("SMTP unexpected reply: " + reply);
				}
				return { code, reply };
			}
			const { value, done } = await this.reader.read();
			if (done) throw new Error("SMTP connection closed early. Last: " + this.buffer);
			this.buffer += this.dec.decode(value, { stream: true });
		}
	}

	async close() {
		try { await this.writer.close(); } catch (e) {}
		try { await this.socket.close(); } catch (e) {}
	}
}

function headerEncode(text) {
	// RFC 2047 so non-ASCII subjects/names survive.
	return /[^\x00-\x7F]/.test(text)
		? "=?UTF-8?B?" + b64(text) + "?="
		: text;
}

/** Build a MIME message with a plain-text and an HTML part. */
function buildMessage({ fromName, fromEmail, to, subject, text, html }) {
	const boundary = "cs_" + Math.random().toString(36).slice(2);
	const date = new Date().toUTCString();
	const lines = [
		`From: ${headerEncode(fromName)} <${fromEmail}>`,
		`To: <${to}>`,
		`Subject: ${headerEncode(subject)}`,
		`Date: ${date}`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		text,
		"",
		`--${boundary}`,
		"Content-Type: text/html; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		html,
		"",
		`--${boundary}--`,
		"",
	];
	// Dot-stuffing: any line starting with "." must be doubled inside DATA.
	return lines.join(CRLF).replace(/\n\./g, "\n..");
}

export async function sendMail(env, { to, subject, text, html }) {
	const user = env.SMTP_USER;
	const pass = String(env.SMTP_PASS || "").replace(/\s+/g, "");   // app passwords ignore spaces
	if (!user || !pass) throw new Error("SMTP is not configured (SMTP_USER / SMTP_PASS).");

	const host = env.SMTP_HOST || "smtp.gmail.com";
	const port = Number(env.SMTP_PORT || 465);
	const fromName = env.SMTP_FROM_NAME || "Cloud Songs";

	const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
	const smtp = new SmtpSession(socket);

	try {
		await smtp.read(["2"]);                       // server greeting
		await smtp.send("EHLO cloud-songs");
		await smtp.read(["2"]);

		await smtp.send("AUTH LOGIN");
		await smtp.read(["3"]);                        // 334 Username:
		await smtp.send(b64(user));
		await smtp.read(["3"]);                        // 334 Password:
		await smtp.send(b64(pass));
		await smtp.read(["2"]);                        // 235 auth ok

		await smtp.send(`MAIL FROM:<${user}>`);
		await smtp.read(["2"]);
		await smtp.send(`RCPT TO:<${to}>`);
		await smtp.read(["2"]);
		await smtp.send("DATA");
		await smtp.read(["3"]);                        // 354 start mail input

		const message = buildMessage({ fromName, fromEmail: user, to, subject, text, html });
		await smtp.send(message + CRLF + ".");
		await smtp.read(["2"]);                        // 250 queued

		await smtp.send("QUIT");
		try { await smtp.read(["2"]); } catch (e) { /* some servers just drop */ }
	} finally {
		await smtp.close();
	}
}
