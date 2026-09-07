import Foundation
import UIKit

/**
 Registers this device's APNs token against the signed-in account.

 The APK does this with Firebase: `MainActivity.registerFcmToken()` hands the FCM
 token to `window.CloudSongsFCM.register`, which POSTs it to `/api/me/fcm`. iOS
 needs no third-party SDK for the same job - APNs gives us the token directly -
 so this posts to `/api/me/apns` instead, and it does so *inside the page* so the
 signed-in session cookie is attached without the shell ever handling it.

 Registration is retried rather than assumed: the token usually arrives before
 the user is signed in, and the authenticated API answers 401 until they are.
 */
final class PushRegistration {

	static let shared = PushRegistration()

	private enum Keys {
		static let token = "cs.apns.token"
		static let registeredToken = "cs.apns.registered"
		static let registeredAt = "cs.apns.registeredAt"
	}

	/// Re-announce a token that is already registered once a day, so the server
	/// can keep `last_used_at` fresh and prune dead devices.
	private let refreshInterval: TimeInterval = 24 * 3600

	private weak var page: PlayerViewController?
	private var inFlight = false

	private init() {}

	func start(page: PlayerViewController) {
		self.page = page
		registerIfNeeded()
	}

	/// APNs handed us a token (called from the app delegate).
	func received(deviceToken: Data) {
		let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
		let defaults = UserDefaults.standard
		if defaults.string(forKey: Keys.token) != hex {
			defaults.set(hex, forKey: Keys.token)
			// A new token invalidates whatever the server has.
			defaults.removeObject(forKey: Keys.registeredToken)
			defaults.removeObject(forKey: Keys.registeredAt)
		}
		registerIfNeeded()
	}

	/// Post the token to the site if it is new, or old enough to refresh.
	/// Safe to call often - on every page load and every foreground.
	func registerIfNeeded() {
		guard !inFlight else { return }
		let defaults = UserDefaults.standard
		guard let token = defaults.string(forKey: Keys.token), !token.isEmpty else { return }

		let alreadyRegistered = defaults.string(forKey: Keys.registeredToken) == token
		let registeredAt = defaults.double(forKey: Keys.registeredAt)
		let stale = Date().timeIntervalSince1970 - registeredAt > refreshInterval
		guard !alreadyRegistered || stale else { return }

		guard let page = page ?? (UIApplication.shared.delegate as? AppDelegate)?.player else { return }
		self.page = page

		inFlight = true
		let quotedToken = Self.jsString(token)
		let quotedPath = Self.jsString(Config.apnsRegisterPath)
		let quotedEnv = Self.jsString(Self.apnsEnvironment)
		page.evaluate("window.CloudSongsAPNs&&CloudSongsAPNs.register(\(quotedToken),\(quotedPath),\(quotedEnv))")
	}

	/// Result of that POST, reported back through the JS bridge.
	func registrationResult(ok: Bool, status: Int) {
		inFlight = false
		guard ok else {
			// 401 simply means "not signed in yet"; the next page load or
			// foreground tries again.
			NSLog("CloudSongs: APNs token not registered (HTTP \(status))")
			return
		}
		let defaults = UserDefaults.standard
		defaults.set(defaults.string(forKey: Keys.token), forKey: Keys.registeredToken)
		defaults.set(Date().timeIntervalSince1970, forKey: Keys.registeredAt)
	}

	/// Which APNs host the server must talk to for this build. A build run from
	/// Xcode gets a sandbox token; TestFlight and the App Store get a production
	/// one. The server also falls back to the other host if Apple rejects the
	/// token, so a wrong guess is recoverable.
	private static var apnsEnvironment: String {
		#if DEBUG
		return "sandbox"
		#else
		return "production"
		#endif
	}

	/// Minimal JSON string quoting, so a token can be embedded in evaluated JS.
	private static func jsString(_ value: String) -> String {
		let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
		if let data = data, let text = String(data: data, encoding: .utf8) {
			// ["..."] -> "..."
			return String(text.dropFirst().dropLast())
		}
		return "\"\""
	}
}
