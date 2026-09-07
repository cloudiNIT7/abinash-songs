import UIKit

/// Everything that is deployment-specific, in one place.
///
/// The iOS app is the counterpart of `android/` - a shell around the live web
/// player rather than a re-implementation of it - so the only real
/// configuration is which site to load and how the native layer behaves around
/// it.
enum Config {

	/// The live site. Same URL the APK loads.
	static let siteURL = URL(string: "https://abinash-songs.pages.dev/")!

	/// Requests to any other host open in Safari instead of inside the app, so
	/// a stray outbound link cannot strand the user in a shell with no chrome.
	static let allowedHosts: Set<String> = [
		"abinash-songs.pages.dev",
	]

	/// `#121212`, the site's own background. Used for the window, the web view
	/// and the launch screen so there is never a white flash.
	static let background = UIColor(red: 0x12 / 255.0, green: 0x12 / 255.0, blue: 0x12 / 255.0, alpha: 1)

	/// How the lock screen / Control Center "now playing" panel is filled in.
	///
	/// WebKit publishes its own now-playing session for media played inside a
	/// `WKWebView` when the page uses the Media Session API (iOS 16.4+), and the
	/// page already does - `setupMediaSession()` in `songs.html`. Writing our
	/// own metadata on top of that means two writers for one panel.
	///
	/// - `.automatic`: let WebKit own the panel when the page reports Media
	///   Session support, and take over when it does not (older iOS). Native
	///   remote-command handlers stay registered either way; they are simply
	///   never called while WebKit owns the session, so this is safe.
	/// - `.always`: always publish native metadata. Use this if the lock screen
	///   ever shows nothing on a supported device.
	static let nowPlayingOwnership: NowPlayingOwnership = .automatic

	enum NowPlayingOwnership {
		case automatic
		case always
	}

	/// A short "Now playing" banner when a new song starts, mirroring the
	/// heads-up notification the Android build posts on its own channel.
	static let showNowPlayingBanner = true

	/// Where the app registers its APNs token. Server side lives in
	/// `functions/api/me/apns.js`.
	static let apnsRegisterPath = "/api/me/apns"
}
