package com.cloudsongs.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.net.URL;

/**
 * Foreground service that owns the MediaSession and the MediaStyle media
 * notification. Running the notification from a foreground service (typed
 * {@code mediaPlayback}) is what makes the "now playing" notification appear
 * reliably on Android 13/14 and OEM skins, and keeps audio alive in the
 * background / with the screen locked.
 *
 * MainActivity pushes track metadata and play state here; the notification's
 * prev / play-pause / next buttons and the lock-screen controls call back into
 * the web player via {@link MainActivity#control(String, long)}.
 */
public class PlaybackService extends Service {

	static final int NOTIF_ID = 42;
	static final int NOTIF_ID_POP = 43;
	static final String CHANNEL = "cloudsongs_media";
	static final String CHANNEL_POP = "cloudsongs_nowplaying";

	static final String ACT_TOGGLE = "com.cloudsongs.app.TOGGLE";
	static final String ACT_NEXT   = "com.cloudsongs.app.NEXT";
	static final String ACT_PREV   = "com.cloudsongs.app.PREV";

	// Metadata pushed in via an Intent from MainActivity.
	static final String EX_TITLE   = "title";
	static final String EX_ARTIST  = "artist";
	static final String EX_ART     = "art";
	static final String EX_PLAYING = "playing";
	static final String EX_POS     = "pos";
	static final String EX_DUR     = "dur";
	static final String CMD        = "cmd";
	static final String CMD_META   = "meta";
	static final String CMD_STATE  = "state";

	private static PlaybackService sInstance;

	private MediaSession session;
	private NotificationManager nm;
	private BroadcastReceiver ctrlReceiver;

	private String mTitle = "", mArtist = "", mArtUrl = "";
	private boolean mPlaying = false;
	private long mPos = 0, mDur = 0;
	private Bitmap mArt = null;
	private boolean mStartedForeground = false;
	private String mAnnounced = "";   // song already shown as a heads-up pop
	private PowerManager.WakeLock mWake;

	@Override
	public void onCreate() {
		super.onCreate();
		sInstance = this;
		nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

		if (Build.VERSION.SDK_INT >= 26) {
			NotificationChannel ch = new NotificationChannel(CHANNEL, "Playback",
					NotificationManager.IMPORTANCE_LOW);
			ch.setShowBadge(false);
			ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
			nm.createNotificationChannel(ch);

			// Separate HIGH-importance channel so a "Now playing" banner pops
			// down from the top of the screen when a new song starts.
			NotificationChannel pop = new NotificationChannel(CHANNEL_POP, "Now playing",
					NotificationManager.IMPORTANCE_HIGH);
			pop.setShowBadge(false);
			pop.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
			pop.enableVibration(false);
			pop.setSound(null, null);
			nm.createNotificationChannel(pop);
		}

		session = new MediaSession(this, "CloudSongs");
		session.setCallback(new MediaSession.Callback() {
			@Override public void onPlay() { MainActivity.control("play", 0); }
			@Override public void onPause() { MainActivity.control("pause", 0); }
			@Override public void onSkipToNext() { MainActivity.control("next", 0); }
			@Override public void onSkipToPrevious() { MainActivity.control("prev", 0); }
			@Override public void onSeekTo(long pos) { MainActivity.control("seek", pos); }
			@Override public void onStop() { MainActivity.control("pause", 0); }
		});
		if (Build.VERSION.SDK_INT < 26) {
			try { session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS); }
			catch (Throwable ignored) {}
		}
		session.setActive(true);

		ctrlReceiver = new BroadcastReceiver() {
			@Override public void onReceive(Context c, Intent i) {
				String a = i.getAction();
				if (ACT_TOGGLE.equals(a)) MainActivity.control("toggle", 0);
				else if (ACT_NEXT.equals(a)) MainActivity.control("next", 0);
				else if (ACT_PREV.equals(a)) MainActivity.control("prev", 0);
			}
		};
		IntentFilter f = new IntentFilter();
		f.addAction(ACT_TOGGLE); f.addAction(ACT_NEXT); f.addAction(ACT_PREV);
		if (Build.VERSION.SDK_INT >= 33) registerReceiver(ctrlReceiver, f, Context.RECEIVER_NOT_EXPORTED);
		else registerReceiver(ctrlReceiver, f);
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		if (intent != null) {
			String cmd = intent.getStringExtra(CMD);
			if (CMD_META.equals(cmd)) {
				String title = intent.getStringExtra(EX_TITLE);
				String artist = intent.getStringExtra(EX_ARTIST);
				String artUrl = intent.getStringExtra(EX_ART);
				android.util.Log.d("CloudSongs", "META title=" + title + " artist=" + artist + " art=" + artUrl);
				mTitle = title == null ? "" : title;
				mArtist = artist == null ? "" : artist;
				if (artUrl == null || !artUrl.equals(mArtUrl)) mArt = null;
				session.setActive(true);
				refreshSession();
				pushNotification();
				loadArt(artUrl);
				// Heads-up "Now playing" banner, once per new song.
				String key = mTitle + "\u0001" + mArtist;
				if (mTitle.length() > 0 && !key.equals(mAnnounced)) {
					mAnnounced = key;
					popNowPlaying();
				}
			} else if (CMD_STATE.equals(cmd)) {
				mPlaying = intent.getBooleanExtra(EX_PLAYING, false);
				mPos = intent.getLongExtra(EX_POS, 0);
				mDur = intent.getLongExtra(EX_DUR, 0);
				android.util.Log.d("CloudSongs", "STATE playing=" + mPlaying + " title=" + mTitle);
				session.setActive(true);
				setWake(mPlaying);
				refreshSession();
				pushNotification();
			}
		}
		// If the service is (re)started with no usable state yet, make sure we
		// still satisfy the startForeground() contract to avoid an ANR/crash.
		if (!mStartedForeground) pushNotification();
		return START_STICKY;
	}

	private PendingIntent bcast(String action) {
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return PendingIntent.getBroadcast(this, action.hashCode(),
				new Intent(action).setPackage(getPackageName()), flags);
	}

	private int pendingFlags() {
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return flags;
	}

	private void refreshSession() {
		MediaMetadata.Builder mb = new MediaMetadata.Builder()
				.putString(MediaMetadata.METADATA_KEY_TITLE, mTitle)
				.putString(MediaMetadata.METADATA_KEY_ARTIST, mArtist)
				.putString(MediaMetadata.METADATA_KEY_ALBUM, "Cloud Songs")
				.putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, mTitle)
				.putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, mArtist)
				.putLong(MediaMetadata.METADATA_KEY_DURATION, mDur);
		if (mArt != null) {
			mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, mArt);
			mb.putBitmap(MediaMetadata.METADATA_KEY_ART, mArt);
			mb.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, mArt);
		}
		session.setMetadata(mb.build());

		long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
				| PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
				| PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
		session.setPlaybackState(new PlaybackState.Builder()
				.setActions(actions)
				.setState(mPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, mPos, 1.0f)
				.build());
	}

	private Notification buildNotification() {
		Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
				? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
		b.setSmallIcon(android.R.drawable.ic_media_play)
				.setContentTitle(mTitle.length() == 0 ? "Cloud Songs" : mTitle)
				.setContentText(mArtist)
				.setVisibility(Notification.VISIBILITY_PUBLIC)
				.setOngoing(mPlaying)
				.setShowWhen(false)
				.setContentIntent(PendingIntent.getActivity(this, 0,
						new Intent(this, MainActivity.class), pendingFlags()));
		if (mArt != null) b.setLargeIcon(mArt);

		b.addAction(new Notification.Action.Builder(
				android.R.drawable.ic_media_previous, "Previous", bcast(ACT_PREV)).build());
		b.addAction(new Notification.Action.Builder(
				mPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
				mPlaying ? "Pause" : "Play", bcast(ACT_TOGGLE)).build());
		b.addAction(new Notification.Action.Builder(
				android.R.drawable.ic_media_next, "Next", bcast(ACT_NEXT)).build());

		if (Build.VERSION.SDK_INT >= 21) {
			Notification.MediaStyle style = new Notification.MediaStyle()
					.setShowActionsInCompactView(0, 1, 2);
			try { style.setMediaSession(session.getSessionToken()); } catch (Throwable ignored) {}
			b.setStyle(style);
		}
		return b.build();
	}

	/** A short "Now playing" banner that pops down from the top of the screen
	 *  on a HIGH-importance channel when a new song starts. This is separate
	 *  from the ongoing media-control notification. */
	private void popNowPlaying() {
		Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
				? new Notification.Builder(this, CHANNEL_POP) : new Notification.Builder(this);
		b.setSmallIcon(android.R.drawable.ic_media_play)
				.setContentTitle("Now playing")
				.setContentText(mArtist.length() > 0 ? (mTitle + " \u2022 " + mArtist) : mTitle)
				.setVisibility(Notification.VISIBILITY_PUBLIC)
				.setAutoCancel(true)
				.setContentIntent(PendingIntent.getActivity(this, 0,
						new Intent(this, MainActivity.class), pendingFlags()));
		if (Build.VERSION.SDK_INT < 26) {
			// Pre-Oreo: HIGH priority is what makes it a heads-up banner.
			b.setPriority(Notification.PRIORITY_HIGH);
			b.setDefaults(Notification.DEFAULT_LIGHTS);
		}
		if (mArt != null) b.setLargeIcon(mArt);
		try { nm.notify(NOTIF_ID_POP, b.build()); } catch (Throwable ignored) {}
	}

	private void pushNotification() {
		Notification n = buildNotification();
		try {
			if (!mStartedForeground) {
				if (Build.VERSION.SDK_INT >= 34) {
					startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
				} else {
					startForeground(NOTIF_ID, n);
				}
				mStartedForeground = true;
			} else {
				nm.notify(NOTIF_ID, n);
			}
		} catch (Throwable ignored) {
			try { nm.notify(NOTIF_ID, n); } catch (Throwable ignored2) {}
		}
	}

	private void loadArt(final String url) {
		if (url == null || url.length() == 0) { mArt = null; return; }
		if (url.equals(mArtUrl) && mArt != null) return;
		mArtUrl = url;
		final String want = url;
		new Thread(new Runnable() {
			public void run() {
				Bitmap bmp = fetchBitmap(want);
				android.util.Log.d("CloudSongs", "ART fetch " + (bmp != null ? (bmp.getWidth() + "x" + bmp.getHeight()) : "FAILED") + " url=" + want);
				// A newer track may have been requested while we were loading;
				// only apply if this URL is still the current one.
				if (bmp != null && want.equals(mArtUrl)) {
					mArt = bmp;
					refreshSession();
					pushNotification();
				}
			}
		}).start();
	}

	/** Download + decode album art, following redirects and downsampling so the
	 *  notification large-icon reliably appears without loading a huge bitmap. */
	private Bitmap fetchBitmap(String url) {
		try {
			byte[] data = readBytes(url);
			if (data == null) return null;

			// First pass: read bounds only, then downsample toward ~512px.
			BitmapFactory.Options bounds = new BitmapFactory.Options();
			bounds.inJustDecodeBounds = true;
			BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
			int sample = 1;
			int max = Math.max(bounds.outWidth, bounds.outHeight);
			while (max / sample > 512) sample *= 2;

			BitmapFactory.Options opts = new BitmapFactory.Options();
			opts.inSampleSize = sample;
			return BitmapFactory.decodeByteArray(data, 0, data.length, opts);
		} catch (Throwable ignored) {
			return null;
		}
	}

	private byte[] readBytes(String url) {
		java.net.HttpURLConnection c = null;
		try {
			// Follow up to a few redirects manually (http<->https redirects are
			// not auto-followed by HttpURLConnection).
			String current = url;
			for (int hop = 0; hop < 4; hop++) {
				c = (java.net.HttpURLConnection) new URL(current).openConnection();
				c.setInstanceFollowRedirects(true);
				c.setConnectTimeout(10000);
				c.setReadTimeout(10000);
				c.setRequestProperty("User-Agent", "CloudSongs/1.0 (Android)");
				int code = c.getResponseCode();
				if (code >= 300 && code < 400) {
					String loc = c.getHeaderField("Location");
					c.disconnect();
					if (loc == null) return null;
					current = new URL(new URL(current), loc).toString();
					continue;
				}
				if (code != java.net.HttpURLConnection.HTTP_OK) return null;
				java.io.InputStream in = c.getInputStream();
				java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
				byte[] buf = new byte[8192];
				int n;
				while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
				in.close();
				return out.toByteArray();
			}
			return null;
		} catch (Throwable ignored) {
			return null;
		} finally {
			try { if (c != null) c.disconnect(); } catch (Throwable ignored) {}
		}
	}

	@Override
	public IBinder onBind(Intent intent) { return null; }

	// The user swiped the app off recents: the WebView holding the audio is
	// gone, so stop the service and clear the notification.
	@Override
	public void onTaskRemoved(Intent rootIntent) {
		try { stopForeground(true); } catch (Throwable ignored) {}
		stopSelf();
		super.onTaskRemoved(rootIntent);
	}

	/** Hold a partial wake lock while playing so audio doesn't cut out when the
	 *  screen turns off; release it when paused/stopped. */
	private void setWake(boolean on) {
		try {
			if (mWake == null) {
				PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
				mWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CloudSongs:playback");
				mWake.setReferenceCounted(false);
			}
			if (on) { if (!mWake.isHeld()) mWake.acquire(); }
			else { if (mWake.isHeld()) mWake.release(); }
		} catch (Throwable ignored) {}
	}

	@Override
	public void onDestroy() {
		try { setWake(false); } catch (Throwable ignored) {}
		try { if (ctrlReceiver != null) unregisterReceiver(ctrlReceiver); } catch (Throwable ignored) {}
		try { if (nm != null) { nm.cancel(NOTIF_ID); nm.cancel(NOTIF_ID_POP); } } catch (Throwable ignored) {}
		try { if (session != null) session.release(); } catch (Throwable ignored) {}
		sInstance = null;
		super.onDestroy();
	}
}
