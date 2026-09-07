import UIKit
import WebKit

/**
 The whole UI: a `WKWebView` running the live site, plus an offline fallback.

 Mirrors `MainActivity`:

 - The default (on-disk) website data store keeps cookies and `localStorage`, so
   the account stays signed in across launches.
 - `mediaTypesRequiringUserActionForPlayback = []` lets the player start audio
   the way it does in a browser tab that has already been interacted with.
 - Swipe-from-the-left walks back through in-app history, standing in for
   Android's hardware Back key.
 - `<input type="file">` (the profile photo picker) is handled by WebKit itself;
   it only needs the usage strings in Info.plist.
 */
final class PlayerViewController: UIViewController {

	private(set) var webView: WKWebView!
	private var errorView: UIView?

	/// Does the page drive `navigator.mediaSession` itself? Decides whether the
	/// native layer publishes now-playing metadata (see `Config`).
	private(set) var pageHasMediaSession = false

	override func loadView() {
		view = UIView()
		view.backgroundColor = Config.background
	}

	override func viewDidLoad() {
		super.viewDidLoad()
		buildWebView()
		load()
	}

	override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

	// MARK: - web view

	private func buildWebView() {
		let controller = WKUserContentController()
		controller.addUserScript(WKUserScript(
			source: BridgeScript.source,
			injectionTime: .atDocumentStart,
			forMainFrameOnly: true
		))
		controller.add(self, name: BridgeScript.handlerName)

		let config = WKWebViewConfiguration()
		config.userContentController = controller
		config.websiteDataStore = .default()          // persistent: cookies survive relaunch
		config.allowsInlineMediaPlayback = true
		config.mediaTypesRequiringUserActionForPlayback = []
		config.allowsPictureInPictureMediaPlayback = true
		config.suppressesIncrementalRendering = false

		let web = WKWebView(frame: .zero, configuration: config)
		web.navigationDelegate = self
		web.uiDelegate = self
		web.allowsBackForwardNavigationGestures = true
		web.backgroundColor = Config.background
		web.isOpaque = false
		web.scrollView.backgroundColor = Config.background
		web.scrollView.contentInsetAdjustmentBehavior = .never
		web.scrollView.bounces = false
		if #available(iOS 16.4, *) {
			// Only useful while debugging from Safari's Develop menu; harmless
			// in a release build, and off by default there anyway.
			#if DEBUG
			web.isInspectable = true
			#endif
		}
		web.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(web)
		NSLayoutConstraint.activate([
			web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
			web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
			web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
			web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
		])
		webView = web
	}

	private func load() {
		clearError()
		webView.load(URLRequest(url: Config.siteURL))
	}

	/// Run JS in the page. Used by the lock-screen controls and by push
	/// registration; always hops to the main thread because those callers arrive
	/// from a media or notification queue.
	func evaluate(_ javaScript: String) {
		if Thread.isMainThread {
			webView?.evaluateJavaScript(javaScript, completionHandler: nil)
		} else {
			DispatchQueue.main.async { [weak self] in
				self?.webView?.evaluateJavaScript(javaScript, completionHandler: nil)
			}
		}
	}

	/// Coming back from the background: JS timers were suspended while we were
	/// away, so ask the page to report where playback actually got to.
	func pageDidReturnToForeground() {
		evaluate("(function(){var a=document.querySelector('audio');if(a&&window.AndroidMedia)"
			+ "AndroidMedia.updatePlayback(!a.paused,Math.floor((a.currentTime||0)*1000),"
			+ "Math.floor((a.duration||0)*1000));})()")
		PushRegistration.shared.registerIfNeeded()
	}

	// MARK: - offline fallback

	/// Same idea as `MainActivity.showError()`: never leave a blank shell behind
	/// when the site cannot be reached.
	private func showError(_ message: String) {
		guard errorView == nil else { return }

		let holder = UIView()
		holder.backgroundColor = Config.background
		holder.translatesAutoresizingMaskIntoConstraints = false

		let label = UILabel()
		label.text = message
		label.textColor = .white
		label.numberOfLines = 0
		label.textAlignment = .center
		label.font = .systemFont(ofSize: 16)
		label.translatesAutoresizingMaskIntoConstraints = false

		var configuration = UIButton.Configuration.filled()
		configuration.title = "Try again"
		configuration.baseBackgroundColor = UIColor(red: 0x1D / 255.0, green: 0xB9 / 255.0, blue: 0x54 / 255.0, alpha: 1)
		configuration.baseForegroundColor = .black
		configuration.cornerStyle = .capsule
		configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 28, bottom: 12, trailing: 28)
		let retry = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
			self?.load()
		})
		retry.translatesAutoresizingMaskIntoConstraints = false

		holder.addSubview(label)
		holder.addSubview(retry)
		view.addSubview(holder)
		NSLayoutConstraint.activate([
			holder.topAnchor.constraint(equalTo: view.topAnchor),
			holder.bottomAnchor.constraint(equalTo: view.bottomAnchor),
			holder.leadingAnchor.constraint(equalTo: view.leadingAnchor),
			holder.trailingAnchor.constraint(equalTo: view.trailingAnchor),

			label.centerYAnchor.constraint(equalTo: holder.centerYAnchor, constant: -40),
			label.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 32),
			label.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -32),

			retry.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 24),
			retry.centerXAnchor.constraint(equalTo: holder.centerXAnchor),
		])
		errorView = holder
	}

	private func clearError() {
		errorView?.removeFromSuperview()
		errorView = nil
	}
}

// MARK: - navigation

extension PlayerViewController: WKNavigationDelegate {

	func webView(
		_ webView: WKWebView,
		decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		guard let url = navigationAction.request.url else {
			decisionHandler(.allow)
			return
		}

		// Anything that is not the app's own site (a support link, a payment
		// page, mailto:) belongs in Safari, not in a chromeless shell.
		if let host = url.host, Config.allowedHosts.contains(host) {
			decisionHandler(.allow)
			return
		}
		if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
			decisionHandler(.allow)
			return
		}
		decisionHandler(.cancel)
		UIApplication.shared.open(url)
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		clearError()
		// A fresh page means a fresh chance to register the push token against
		// whatever session is now signed in.
		PushRegistration.shared.registerIfNeeded()
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		failed(error)
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		failed(error)
	}

	private func failed(_ error: Error) {
		let code = (error as NSError).code
		// -999 is "cancelled", which happens on every redirect the user
		// out-runs; it is not a failure worth a full-screen message.
		guard code != NSURLErrorCancelled else { return }
		guard webView.url == nil || !(webView.url?.absoluteString.hasPrefix("http") ?? false) else { return }
		showError("Couldn't load Cloud Songs.\nCheck your internet connection and try again.")
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		// The content process was jettisoned (usually memory pressure while
		// backgrounded). Reload rather than sitting on a blank view.
		load()
	}
}

// MARK: - UI delegate

extension PlayerViewController: WKUIDelegate {

	/// `target="_blank"` has nowhere to go in a single-web-view app, so load it
	/// in place when it is our own site and hand it to Safari otherwise.
	func webView(
		_ webView: WKWebView,
		createWebViewWith configuration: WKWebViewConfiguration,
		for navigationAction: WKNavigationAction,
		windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		guard let url = navigationAction.request.url else { return nil }
		if let host = url.host, Config.allowedHosts.contains(host) {
			webView.load(URLRequest(url: url))
		} else {
			UIApplication.shared.open(url)
		}
		return nil
	}

	/// The page uses alert/confirm in a couple of places; without these WebKit
	/// silently drops them.
	func webView(
		_ webView: WKWebView,
		runJavaScriptAlertPanelWithMessage message: String,
		initiatedByFrame frame: WKFrameInfo,
		completionHandler: @escaping () -> Void
	) {
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
		present(alert, animated: true)
	}

	func webView(
		_ webView: WKWebView,
		runJavaScriptConfirmPanelWithMessage message: String,
		initiatedByFrame frame: WKFrameInfo,
		completionHandler: @escaping (Bool) -> Void
	) {
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
		alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
		present(alert, animated: true)
	}
}

// MARK: - messages from the page

extension PlayerViewController: WKScriptMessageHandler {

	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		guard let body = message.body as? [String: Any],
			  let type = body["type"] as? String else { return }

		switch type {
		case "ready":
			pageHasMediaSession = (body["mediaSession"] as? Bool) ?? false

		case "meta":
			let title = (body["title"] as? String) ?? ""
			let artist = (body["artist"] as? String) ?? ""
			let art = (body["art"] as? String) ?? ""
			NowPlayingCenter.shared.updateMetadata(title: title, artist: artist, artworkURL: art)

		case "state":
			let playing = (body["playing"] as? Bool) ?? false
			let position = ((body["position"] as? NSNumber)?.doubleValue ?? 0) / 1000
			let duration = ((body["duration"] as? NSNumber)?.doubleValue ?? 0) / 1000
			NowPlayingCenter.shared.updateState(playing: playing, position: position, duration: duration)

		case "apns":
			let ok = (body["ok"] as? Bool) ?? false
			let status = (body["status"] as? NSNumber)?.intValue ?? 0
			PushRegistration.shared.registrationResult(ok: ok, status: status)

		default:
			break
		}
	}
}
