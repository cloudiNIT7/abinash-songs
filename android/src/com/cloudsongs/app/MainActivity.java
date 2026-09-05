package com.cloudsongs.app;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.net.URL;

/**
 * Cloud Songs Android shell.
 *
 * A WebView pointed at the live site, PLUS a native media notification: the web
 * player pushes track metadata + play state through the "AndroidMedia" JS
 * bridge, and we mirror it into a framework MediaSession and a MediaStyle
 * notification (cover, title, artist, prev/play-pause/next). The notification
 * and lock-screen controls call back into the page via window.CloudSongsControl.
 */
public class MainActivity extends Activity {

	private static final String APP_URL = "https://abinash-songs.pages.dev/";
	private static final int FILE_REQ = 1001;
	private static final int NOTIF_ID = 42;
	private static final String CHANNEL = "cloudsongs_media";
	private static final String ACT_TOGGLE = "com.cloudsongs.app.TOGGLE";
	private static final String ACT_NEXT = "com.cloudsongs.app.NEXT";
	private static final String ACT_PREV = "com.cloudsongs.app.PREV";

	private WebView web;
	private FrameLayout root;
	private ValueCallback<Uri[]> filePathCallback;

	private MediaSession session;
	private NotificationManager nm;
	private BroadcastReceiver ctrlReceiver;

	private String mTitle = "", mArtist = "", mArtUrl = "";
	private boolean mPlaying = false;
	private long mPos = 0, mDur = 0;
	private Bitmap mArt = null;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		root = new FrameLayout(this);
		root.setBackgroundColor(Color.parseColor("#121212"));
		setContentView(root);

		if (Build.VERSION.SDK_INT >= 33) {
			try { requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" }, 2001); }
			catch (Throwable ignored) {}
		}

		setupMedia();

		try {
			web = new WebView(this);
			web.setBackgroundColor(Color.parseColor("#121212"));
			root.addView(web, new FrameLayout.LayoutParams(
					ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

			WebSettings s = web.getSettings();
			s.setJavaScriptEnabled(true);
			s.setDomStorageEnabled(true);
			s.setDatabaseEnabled(true);
			s.setMediaPlaybackRequiresUserGesture(false);
			s.setLoadWithOverviewMode(true);
			s.setUseWideViewPort(true);
			s.setSupportZoom(false);

			try {
				CookieManager.getInstance().setAcceptCookie(true);
				CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
			} catch (Throwable ignored) {}

			web.addJavascriptInterface(new MediaBridge(), "AndroidMedia");

			web.setWebViewClient(new WebViewClient() {
				@Override
				public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
					if (Build.VERSION.SDK_INT >= 21 && request != null && request.isForMainFrame()) showError();
				}
			});
			web.setWebChromeClient(new WebChromeClient() {
				@Override
				public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
					filePathCallback = cb;
					try { startActivityForResult(params.createIntent(), FILE_REQ); }
					catch (Exception e) { filePathCallback = null; return false; }
					return true;
				}
			});

			if (savedInstanceState != null) web.restoreState(savedInstanceState);
			else web.loadUrl(APP_URL);
		} catch (Throwable t) {
			showError();
		}
	}

	/* ---------- native media session + notification ---------- */

	private void setupMedia() {
		nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		if (Build.VERSION.SDK_INT >= 26) {
			NotificationChannel ch = new NotificationChannel(CHANNEL, "Playback",
					NotificationManager.IMPORTANCE_LOW);
			ch.setShowBadge(false);
			ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
			nm.createNotificationChannel(ch);
		}

		session = new MediaSession(this, "CloudSongs");
		session.setCallback(new MediaSession.Callback() {
			@Override public void onPlay() { js("window.CloudSongsControl&&CloudSongsControl.play()"); }
			@Override public void onPause() { js("window.CloudSongsControl&&CloudSongsControl.pause()"); }
			@Override public void onSkipToNext() { js("window.CloudSongsControl&&CloudSongsControl.next()"); }
			@Override public void onSkipToPrevious() { js("window.CloudSongsControl&&CloudSongsControl.prev()"); }
			@Override public void onSeekTo(long pos) { js("window.CloudSongsControl&&CloudSongsControl.seek(" + pos + ")"); }
			@Override public void onStop() { js("window.CloudSongsControl&&CloudSongsControl.pause()"); }
		});
		if (Build.VERSION.SDK_INT < 26) {
			try { session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS); }
			catch (Throwable ignored) {}
		}
		session.setActive(true);

		ctrlReceiver = new BroadcastReceiver() {
			@Override public void onReceive(Context c, Intent i) {
				String a = i.getAction();
				if (ACT_TOGGLE.equals(a)) js("window.CloudSongsControl&&CloudSongsControl.toggle()");
				else if (ACT_NEXT.equals(a)) js("window.CloudSongsControl&&CloudSongsControl.next()");
				else if (ACT_PREV.equals(a)) js("window.CloudSongsControl&&CloudSongsControl.prev()");
			}
		};
		IntentFilter f = new IntentFilter();
		f.addAction(ACT_TOGGLE); f.addAction(ACT_NEXT); f.addAction(ACT_PREV);
		if (Build.VERSION.SDK_INT >= 33) registerReceiver(ctrlReceiver, f, Context.RECEIVER_NOT_EXPORTED);
		else registerReceiver(ctrlReceiver, f);
	}

	private void js(final String code) {
		runOnUiThread(new Runnable() {
			public void run() { if (web != null) web.evaluateJavascript(code, null); }
		});
	}

	private PendingIntent bcast(String action) {
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return PendingIntent.getBroadcast(this, action.hashCode(), new Intent(action).setPackage(getPackageName()), flags);
	}

	private void refreshSession() {
		MediaMetadata.Builder mb = new MediaMetadata.Builder()
				.putString(MediaMetadata.METADATA_KEY_TITLE, mTitle)
				.putString(MediaMetadata.METADATA_KEY_ARTIST, mArtist)
				.putString(MediaMetadata.METADATA_KEY_ALBUM, "Cloud Songs")
				.putLong(MediaMetadata.METADATA_KEY_DURATION, mDur);
		if (mArt != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, mArt);
		session.setMetadata(mb.build());

		long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
				| PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
				| PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
		session.setPlaybackState(new PlaybackState.Builder()
				.setActions(actions)
				.setState(mPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, mPos, 1.0f)
				.build());
	}

	private void showNotification() {
		if (mTitle.length() == 0) return;
		Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
				? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
		b.setSmallIcon(android.R.drawable.ic_media_play)
				.setContentTitle(mTitle)
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
		try { nm.notify(NOTIF_ID, b.build()); } catch (Throwable ignored) {}
	}

	private int pendingFlags() {
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return flags;
	}

	private void loadArt(final String url) {
		if (url == null || url.length() == 0) { mArt = null; return; }
		if (url.equals(mArtUrl) && mArt != null) return;
		mArtUrl = url;
		new Thread(new Runnable() {
			public void run() {
				try {
					java.io.InputStream in = new URL(url).openStream();
					final Bitmap bmp = BitmapFactory.decodeStream(in);
					in.close();
					if (bmp != null) runOnUiThread(new Runnable() {
						public void run() { mArt = bmp; refreshSession(); showNotification(); }
					});
				} catch (Throwable ignored) {}
			}
		}).start();
	}

	/** Called from JS (background thread) — always hop to the UI thread. */
	private class MediaBridge {
		@JavascriptInterface
		public void updateMetadata(final String title, final String artist, final String artUrl) {
			runOnUiThread(new Runnable() {
				public void run() {
					mTitle = title == null ? "" : title;
					mArtist = artist == null ? "" : artist;
					if (artUrl == null || !artUrl.equals(mArtUrl)) mArt = null;
					refreshSession();
					showNotification();
					loadArt(artUrl);
				}
			});
		}
		@JavascriptInterface
		public void updatePlayback(final boolean playing, final long positionMs, final long durationMs) {
			runOnUiThread(new Runnable() {
				public void run() {
					mPlaying = playing; mPos = positionMs; mDur = durationMs;
					session.setActive(true);
					refreshSession();
					showNotification();
				}
			});
		}
	}

	private void showError() {
		TextView tv = new TextView(this);
		tv.setText("Couldn't load Cloud Songs.\nCheck your internet connection and reopen the app.");
		tv.setTextColor(Color.WHITE); tv.setTextSize(16); tv.setPadding(48, 48, 48, 48);
		FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
		lp.gravity = android.view.Gravity.CENTER;
		if (root != null) { root.removeAllViews(); root.addView(tv, lp); }
	}

	@Override
	protected void onActivityResult(int requestCode, int resultCode, Intent data) {
		if (requestCode == FILE_REQ) {
			Uri[] result = (resultCode == RESULT_OK && data != null && data.getData() != null)
					? new Uri[]{ data.getData() } : null;
			if (filePathCallback != null) filePathCallback.onReceiveValue(result);
			filePathCallback = null;
		} else {
			super.onActivityResult(requestCode, resultCode, data);
		}
	}

	@Override
	public boolean onKeyDown(int keyCode, KeyEvent event) {
		if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) { web.goBack(); return true; }
		return super.onKeyDown(keyCode, event);
	}

	@Override
	protected void onSaveInstanceState(Bundle outState) {
		super.onSaveInstanceState(outState);
		if (web != null) web.saveState(outState);
	}

	@Override
	protected void onDestroy() {
		try { if (ctrlReceiver != null) unregisterReceiver(ctrlReceiver); } catch (Throwable ignored) {}
		try { if (nm != null) nm.cancel(NOTIF_ID); } catch (Throwable ignored) {}
		try { if (session != null) session.release(); } catch (Throwable ignored) {}
		super.onDestroy();
	}
}
