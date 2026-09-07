import Foundation
import MediaPlayer
import UIKit

/**
 The lock screen / Control Center / CarPlay panel, and the buttons on it.

 This is the iOS half of `android/src/com/cloudsongs/app/PlaybackService.java`.
 iOS needs no foreground service - the `audio` background mode plus a `.playback`
 audio session keep the web view's `<audio>` alive - so what is left is the same
 two jobs the Android service did:

 1. Publish what is playing (title, artist, cover, duration, elapsed).
 2. Turn the transport buttons back into calls on `window.CloudSongsControl`.

 Metadata is only published when the page is not already doing it through the
 Media Session API; see `Config.nowPlayingOwnership` for why.
 */
final class NowPlayingCenter {

	static let shared = NowPlayingCenter()

	private weak var page: PlayerViewController?

	private var title = ""
	private var artist = ""
	private var artworkURL = ""
	private var duration: TimeInterval = 0
	private var position: TimeInterval = 0
	private var playing = false

	/// The song we have already announced with a "Now playing" banner, so a
	/// state update does not re-announce the same track.
	private var announced = ""

	private var artwork: MPMediaItemArtwork?
	private var artworkCacheKey = ""
	private var artworkTask: URLSessionDataTask?

	private init() {}

	// MARK: - lifecycle

	func start(page: PlayerViewController) {
		self.page = page
		registerCommands()
	}

	private func registerCommands() {
		let center = MPRemoteCommandCenter.shared()

		center.playCommand.isEnabled = true
		_ = center.playCommand.addTarget { [weak self] _ in
			self?.send("play")
			return .success
		}

		center.pauseCommand.isEnabled = true
		_ = center.pauseCommand.addTarget { [weak self] _ in
			self?.send("pause")
			return .success
		}

		center.togglePlayPauseCommand.isEnabled = true
		_ = center.togglePlayPauseCommand.addTarget { [weak self] _ in
			self?.send("toggle")
			return .success
		}

		center.nextTrackCommand.isEnabled = true
		_ = center.nextTrackCommand.addTarget { [weak self] _ in
			self?.send("next")
			return .success
		}

		center.previousTrackCommand.isEnabled = true
		_ = center.previousTrackCommand.addTarget { [weak self] _ in
			self?.send("prev")
			return .success
		}

		center.stopCommand.isEnabled = true
		_ = center.stopCommand.addTarget { [weak self] _ in
			self?.send("pause")
			return .success
		}

		// Dragging the lock-screen scrubber.
		center.changePlaybackPositionCommand.isEnabled = true
		_ = center.changePlaybackPositionCommand.addTarget { [weak self] event in
			guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
			self?.seek(to: event.positionTime)
			return .success
		}
	}

	/// Same wire format as `MainActivity.control()`: one call on the page's
	/// transport object, which the web player owns.
	private func send(_ action: String) {
		page?.evaluate("window.CloudSongsControl&&CloudSongsControl.\(action)()")
	}

	private func seek(to seconds: TimeInterval) {
		let ms = Int((seconds * 1000).rounded())
		position = seconds
		page?.evaluate("window.CloudSongsControl&&CloudSongsControl.seek(\(ms))")
		publish()
	}

	// MARK: - updates from the page

	func updateMetadata(title: String, artist: String, artworkURL: String) {
		let changedTrack = (title != self.title || artist != self.artist)
		self.title = title
		self.artist = artist

		if artworkURL != self.artworkURL {
			self.artworkURL = artworkURL
			loadArtwork(artworkURL)
		}
		publish()

		// The heads-up "Now playing" banner, once per new song - the equivalent
		// of the APK's high-importance notification channel.
		let key = title + "\u{1}" + artist
		if Config.showNowPlayingBanner, !title.isEmpty, changedTrack, key != announced {
			announced = key
			Notifications.shared.showNowPlaying(title: title, artist: artist, artworkURL: artworkURL)
		}
	}

	func updateState(playing: Bool, position: TimeInterval, duration: TimeInterval) {
		self.playing = playing
		self.position = position
		if duration.isFinite, duration > 0 { self.duration = duration }
		publish()
	}

	// MARK: - publishing

	private var shouldPublish: Bool {
		switch Config.nowPlayingOwnership {
		case .always:
			return true
		case .automatic:
			// WebKit already fills the panel from the page's Media Session.
			return !(page?.pageHasMediaSession ?? false)
		}
	}

	private func publish() {
		guard shouldPublish else { return }
		guard !title.isEmpty else { return }

		var info: [String: Any] = [
			MPMediaItemPropertyTitle: title,
			MPMediaItemPropertyArtist: artist,
			MPMediaItemPropertyAlbumTitle: "Cloud Songs",
			MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
			MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
			MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
			MPNowPlayingInfoPropertyIsLiveStream: false,
		]
		if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
		if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }

		MPNowPlayingInfoCenter.default().nowPlayingInfo = info
		if #available(iOS 13.0, *) {
			MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
		}
	}

	/// Download the cover once per URL. The panel scales whatever it is given,
	/// and the site serves 500x500 art, so no resizing is needed here.
	private func loadArtwork(_ urlString: String) {
		guard let url = URL(string: urlString), !urlString.isEmpty else {
			artwork = nil
			artworkCacheKey = ""
			publish()
			return
		}
		if artworkCacheKey == urlString, artwork != nil { return }

		artworkTask?.cancel()
		let task = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
			guard let self = self,
				  let data = data,
				  let image = UIImage(data: data) else { return }
			// A newer track may have been asked for while this was in flight.
			guard self.artworkURL == urlString else { return }
			self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
			self.artworkCacheKey = urlString
			DispatchQueue.main.async { self.publish() }
		}
		artworkTask = task
		task.resume()
	}

	/// Album art for the current track, if it is already downloaded. Used to
	/// give the "Now playing" banner the same cover.
	var currentArtworkImage: UIImage? {
		guard let artwork = artwork else { return nil }
		return artwork.image(at: CGSize(width: 512, height: 512))
	}
}
