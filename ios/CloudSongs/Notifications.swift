import UIKit
import UserNotifications

/**
 Notifications: the "Now playing" banner, the sign-in-approval alert and the
 listening suggestions.

 Android splits these across two channels (`cloudsongs_nowplaying` for the banner
 and `cloudsongs_approval` for approvals) so muting the chatty one never silences
 the security one. iOS has no per-channel muting, so the same separation is
 expressed with thread identifiers and interruption levels: approvals are
 time-sensitive, the now-playing banner is passive.

 Approval and suggestion alerts arrive from the server over APNs
 (`functions/_lib/apns.js`), which replaces the APK's Firebase channel. The
 payload is content-free for approvals, exactly like the Web Push and FCM paths:
 the details are only ever read from the API once the app is open.
 */
final class Notifications: NSObject {

	static let shared = Notifications()

	static let nowPlayingID = "cs-nowplaying"
	static let approvalID = "cs-approval"
	static let categoryNowPlaying = "CS_NOW_PLAYING"
	static let categoryApproval = "CS_APPROVAL"
	static let categorySuggestion = "CS_SUGGEST"

	private weak var page: PlayerViewController?
	private var nudgedAboutSettings = false

	private override init() { super.init() }

	// MARK: - setup

	func start(page: PlayerViewController) {
		self.page = page

		let center = UNUserNotificationCenter.current()
		center.delegate = self
		center.setNotificationCategories([
			UNNotificationCategory(identifier: Notifications.categoryNowPlaying,
								   actions: [], intentIdentifiers: [], options: []),
			UNNotificationCategory(identifier: Notifications.categoryApproval,
								   actions: [], intentIdentifiers: [], options: []),
			UNNotificationCategory(identifier: Notifications.categorySuggestion,
								   actions: [], intentIdentifiers: [], options: []),
		])

		center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
			NSLog("CloudSongs: notification authorization granted=\(granted)")
			// Register for APNs either way: a silent push still reaches a device
			// whose alerts are muted, and the token is what the server needs.
			DispatchQueue.main.async {
				UIApplication.shared.registerForRemoteNotifications()
			}
		}
	}

	/// Surface, on-screen, that alerts are switched off - the counterpart of
	/// `MainActivity.checkNotifStatus()`. Offered once per launch, and only when
	/// the user has actually denied them.
	func refreshAuthorizationState() {
		UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
			guard settings.authorizationStatus == .denied else { return }
			DispatchQueue.main.async { self?.offerSettings() }
		}
	}

	private func offerSettings() {
		guard !nudgedAboutSettings, let page = page, page.view.window != nil else { return }
		nudgedAboutSettings = true

		let alert = UIAlertController(
			title: "Notifications are off",
			message: "Cloud Songs can't show the now-playing banner or alert you when someone signs in to your account.",
			preferredStyle: .alert
		)
		alert.addAction(UIAlertAction(title: "Not now", style: .cancel))
		alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
			if let url = URL(string: UIApplication.openSettingsURLString) {
				UIApplication.shared.open(url)
			}
		})
		page.present(alert, animated: true)
	}

	// MARK: - now playing banner

	/// A short banner when a new song starts, matching the APK's heads-up
	/// "Now playing" notification. Only posted while the app is not on screen:
	/// in the foreground the player's own now-playing bar already says this, and
	/// a banner would cover it.
	func showNowPlaying(title: String, artist: String, artworkURL: String) {
		guard UIApplication.shared.applicationState != .active else { return }

		let content = UNMutableNotificationContent()
		content.title = "Now playing"
		content.body = artist.isEmpty ? title : "\(title) \u{2022} \(artist)"
		content.sound = nil
		content.categoryIdentifier = Notifications.categoryNowPlaying
		content.threadIdentifier = Notifications.nowPlayingID
		if #available(iOS 15.0, *) { content.interruptionLevel = .passive }
		if let attachment = artworkAttachment() { content.attachments = [attachment] }

		// A fixed identifier means a new song replaces the previous banner
		// instead of stacking, the way the APK reuses one notification id.
		let request = UNNotificationRequest(identifier: Notifications.nowPlayingID, content: content, trigger: nil)
		UNUserNotificationCenter.current().add(request)
	}

	/// Attach the cover that `NowPlayingCenter` has already downloaded, so the
	/// banner shows artwork like the Android one does.
	private func artworkAttachment() -> UNNotificationAttachment? {
		guard let image = NowPlayingCenter.shared.currentArtworkImage,
			  let data = image.jpegData(compressionQuality: 0.8) else { return nil }
		let url = FileManager.default.temporaryDirectory
			.appendingPathComponent("cs-art-\(UUID().uuidString).jpg")
		do {
			try data.write(to: url)
			return try UNNotificationAttachment(identifier: "art", url: url, options: nil)
		} catch {
			return nil
		}
	}

	// MARK: - push

	/// A background (`content-available`) push. Approvals carry nothing but
	/// "something is waiting", so raise the same prompt the APK raises and let
	/// the page's approval poll fill in the details once opened.
	func handleSilentPush(_ userInfo: [AnyHashable: Any]) {
		let kind = (userInfo["kind"] as? String) ?? ""
		let hasAlert = (userInfo["aps"] as? [AnyHashable: Any])?["alert"] != nil
		guard !hasAlert else { return }        // the system is already showing it

		if kind == "approval" {
			showApprovalPrompt()
		}
		nudgePageToPoll()
	}

	/// Ask the page to re-check what is waiting, now, rather than at the next
	/// poll. The player already re-checks the session whenever the tab becomes
	/// visible (`visibilitychange` in `songs.html`), so firing that existing hook
	/// is the nudge - no page change needed, and it is a no-op while the web view
	/// is genuinely hidden, which is exactly when the notification does the job
	/// instead.
	private func nudgePageToPoll() {
		page?.evaluate("try{document.dispatchEvent(new Event('visibilitychange'))}catch(e){}")
	}

	private func showApprovalPrompt() {
		let content = UNMutableNotificationContent()
		content.title = "Approve sign-in to Cloud Songs?"
		content.body = "Someone signed in with your password. Tap to review."
		content.sound = .default
		content.categoryIdentifier = Notifications.categoryApproval
		content.threadIdentifier = Notifications.approvalID
		if #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }

		let request = UNNotificationRequest(identifier: Notifications.approvalID, content: content, trigger: nil)
		UNUserNotificationCenter.current().add(request)
	}
}

// MARK: - UNUserNotificationCenterDelegate

extension Notifications: UNUserNotificationCenterDelegate {

	/// What to do with an alert that lands while the app is open. Approvals and
	/// suggestions are worth a banner; the now-playing one is not (it is only
	/// posted when we are backgrounded anyway).
	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		let category = notification.request.content.categoryIdentifier
		if category == Notifications.categoryNowPlaying {
			completionHandler([])
			return
		}
		if #available(iOS 14.0, *) {
			completionHandler([.banner, .sound, .list])
		} else {
			completionHandler([.alert, .sound])
		}
	}

	/// The notification was tapped. Everything in this app lives in one web
	/// view, and it is already loaded, so the tap simply brings it forward -
	/// deliberately without reloading, so the song keeps playing. This is the
	/// same reasoning as `MainActivity.onNewIntent()`.
	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		let info = response.notification.request.content.userInfo
		if let kind = info["kind"] as? String, kind == "approval" {
			// The page polls /api/me/approvals and draws the Approve / Deny
			// prompt itself; give it a nudge so it happens now.
			nudgePageToPoll()
		}
		completionHandler()
	}
}
