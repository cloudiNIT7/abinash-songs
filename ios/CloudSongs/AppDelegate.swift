import AVFoundation
import UIKit
import UserNotifications

/**
 Cloud Songs iOS shell.

 The counterpart of `android/src/com/cloudsongs/app/MainActivity.java`: a web
 view pointed at the live site, plus the native pieces a browser tab cannot do.

 - `AVAudioSession` in `.playback` + the `audio` background mode keep the song
   playing when the app is backgrounded or the screen is locked. This is the iOS
   equivalent of the Android foreground service.
 - `NowPlayingCenter` owns the lock screen / Control Center panel and forwards
   its buttons into the page (`window.CloudSongsControl`), the same contract the
   Android media notification uses.
 - `PushRegistration` hands the APNs device token to the site so a closed app
   can be woken for a sign-in approval, replacing the APK's FCM channel.
 */
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

	var window: UIWindow?

	/// The one web view shell. Held here so push and notification callbacks can
	/// reach the page without walking the view hierarchy.
	private(set) var player: PlayerViewController?

	func application(
		_ application: UIApplication,
		didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
	) -> Bool {
		configureAudioSession()

		let player = PlayerViewController()
		self.player = player

		let window = UIWindow(frame: UIScreen.main.bounds)
		window.backgroundColor = Config.background
		window.rootViewController = player
		window.makeKeyAndVisible()
		self.window = window

		NowPlayingCenter.shared.start(page: player)
		Notifications.shared.start(page: player)
		PushRegistration.shared.start(page: player)

		return true
	}

	/// The single most important line for background playback: a `.playback`
	/// session tells iOS this app makes audio the user is listening to, so the
	/// web view's `<audio>` keeps running after the app leaves the screen and
	/// audio is not silenced by the ringer switch.
	private func configureAudioSession() {
		let session = AVAudioSession.sharedInstance()
		do {
			try session.setCategory(.playback, mode: .default, options: [])
			try session.setActive(true)
		} catch {
			NSLog("CloudSongs: audio session setup failed: \(error.localizedDescription)")
		}
	}

	/* ---------- APNs ---------- */

	func application(
		_ application: UIApplication,
		didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
	) {
		PushRegistration.shared.received(deviceToken: deviceToken)
	}

	func application(
		_ application: UIApplication,
		didFailToRegisterForRemoteNotificationsWithError error: Error
	) {
		// No push on this build (simulator, or no push entitlement yet). The
		// in-app approval poll still works, exactly like an APK built without
		// Firebase.
		NSLog("CloudSongs: APNs registration failed: \(error.localizedDescription)")
	}

	/// A background push arrived. Approvals are content-free by design - the
	/// details are only ever read from the API - so all this does is let the
	/// page catch up while we are briefly awake.
	func application(
		_ application: UIApplication,
		didReceiveRemoteNotification userInfo: [AnyHashable: Any],
		fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
	) {
		Notifications.shared.handleSilentPush(userInfo)
		completionHandler(.noData)
	}

	/* ---------- lifecycle ---------- */

	func applicationWillEnterForeground(_ application: UIApplication) {
		player?.pageDidReturnToForeground()
	}

	func applicationDidBecomeActive(_ application: UIApplication) {
		// Re-assert the session: another app may have taken it while we were away.
		configureAudioSession()
		Notifications.shared.refreshAuthorizationState()
		PushRegistration.shared.registerIfNeeded()
	}
}
