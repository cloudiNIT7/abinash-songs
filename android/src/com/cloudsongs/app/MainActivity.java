package com.cloudsongs.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
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

/**
 * Cloud Songs Android shell.
 *
 * A WebView pointed at the live site. The web player pushes track metadata +
 * play state through the "AndroidMedia" JS bridge; we forward those to
 * {@link PlaybackService}, a foreground service that owns the MediaSession and
 * the media notification (cover, title, artist, prev/play-pause/next). Running
 * the notification from a foreground service is what makes it show reliably on
 * Android 13/14 and OEM skins and keeps audio alive in the background.
 *
 * The notification and lock-screen controls call back into the page via
 * {@link #control(String, long)} → window.CloudSongsControl.
 */
public class MainActivity extends Activity {

	private static final String APP_URL = "https://abinash-songs.pages.dev/";
	private static final int FILE_REQ = 1001;

	private WebView web;
	private FrameLayout root;
	private ValueCallback<Uri[]> filePathCallback;

	// Lets PlaybackService (notification / lock-screen buttons) reach the WebView.
	private static MainActivity sInstance;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		sInstance = this;

		root = new FrameLayout(this);
		root.setBackgroundColor(Color.parseColor("#121212"));
		setContentView(root);

		if (Build.VERSION.SDK_INT >= 33) {
			try { requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" }, 2001); }
			catch (Throwable ignored) {}
		}

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

	/* ---------- bridge from PlaybackService back into the web player ---------- */

	/** Called by PlaybackService when a notification / lock-screen button is hit. */
	static void control(String action, long arg) {
		final MainActivity a = sInstance;
		if (a == null) return;
		final String code;
		if ("seek".equals(action)) code = "window.CloudSongsControl&&CloudSongsControl.seek(" + arg + ")";
		else code = "window.CloudSongsControl&&CloudSongsControl." + action + "()";
		a.js(code);
	}

	private void js(final String code) {
		runOnUiThread(new Runnable() {
			public void run() { if (web != null) web.evaluateJavascript(code, null); }
		});
	}

	/* ---------- forward metadata / state from the page to the service ---------- */

	private void sendToService(Intent i) {
		try {
			if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
			else startService(i);
		} catch (Throwable ignored) {}
	}

	/** Called from JS (background thread). */
	private class MediaBridge {
		@JavascriptInterface
		public void updateMetadata(String title, String artist, String artUrl) {
			android.util.Log.d("CloudSongs", "bridge.updateMetadata title=" + title + " art=" + artUrl);
			Intent i = new Intent(MainActivity.this, PlaybackService.class);
			i.putExtra(PlaybackService.CMD, PlaybackService.CMD_META);
			i.putExtra(PlaybackService.EX_TITLE, title == null ? "" : title);
			i.putExtra(PlaybackService.EX_ARTIST, artist == null ? "" : artist);
			i.putExtra(PlaybackService.EX_ART, artUrl == null ? "" : artUrl);
			sendToService(i);
		}
		@JavascriptInterface
		public void updatePlayback(boolean playing, long positionMs, long durationMs) {
			Intent i = new Intent(MainActivity.this, PlaybackService.class);
			i.putExtra(PlaybackService.CMD, PlaybackService.CMD_STATE);
			i.putExtra(PlaybackService.EX_PLAYING, playing);
			i.putExtra(PlaybackService.EX_POS, positionMs);
			i.putExtra(PlaybackService.EX_DUR, durationMs);
			sendToService(i);
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
		if (sInstance == this) sInstance = null;
		try { stopService(new Intent(this, PlaybackService.class)); } catch (Throwable ignored) {}
		super.onDestroy();
	}
}
