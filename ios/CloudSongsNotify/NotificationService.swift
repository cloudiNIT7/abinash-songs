import UIKit
import UserNotifications

/**
 Adds the album art to a pushed notification.

 On Android, Firebase renders `notification.image` itself, which is why the
 suggestion nudges show a cover. iOS never downloads images for you: an APNs
 payload with `mutable-content: 1` is handed to this extension first, and
 whatever it attaches is what the banner shows.

 The image URL rides in the payload as `image` (see `functions/_lib/apns.js`).
 Anything that fails here - no URL, no network, a slow server - falls through to
 the plain text notification, which is the same content minus the picture.
 */
final class NotificationService: UNNotificationServiceExtension {

	private var handler: ((UNNotificationContent) -> Void)?
	private var content: UNMutableNotificationContent?

	override func didReceive(
		_ request: UNNotificationRequest,
		withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
	) {
		handler = contentHandler
		let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
		content = mutable

		guard let mutable = mutable,
			  let urlString = mutable.userInfo["image"] as? String,
			  let url = URL(string: urlString), url.scheme == "https" else {
			contentHandler(request.content)
			return
		}

		let task = URLSession.shared.downloadTask(with: url) { temporary, response, _ in
			defer { contentHandler(mutable) }
			guard let temporary = temporary else { return }

			// UNNotificationAttachment needs a file whose extension matches the
			// content type, and it takes ownership of what it is given.
			let suffix = (response?.mimeType == "image/png") ? "png" : "jpg"
			let destination = FileManager.default.temporaryDirectory
				.appendingPathComponent("cs-push-\(UUID().uuidString).\(suffix)")
			do {
				try FileManager.default.moveItem(at: temporary, to: destination)
				let attachment = try UNNotificationAttachment(identifier: "image", url: destination, options: nil)
				mutable.attachments = [attachment]
			} catch {
				// Keep the text-only notification.
			}
		}
		task.resume()
	}

	/// iOS is about to stop us (roughly 30s). Deliver what we have.
	override func serviceExtensionTimeWillExpire() {
		if let handler = handler, let content = content {
			handler(content)
		}
	}
}
