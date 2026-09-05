package com.cloudsongs.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
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
import android.widget.Toast;

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
			try {
				if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
						!= PackageManager.PERMISSION_GRANTED) {
					requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" }, 2001);
				}
			} catch (Throwable ignored) {}
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
				@Override
				public void onPageFinished(WebView view, String url) {
					injectMediaWatcher();
					// Capture the session cookie right after a login/redirect so the
					// profile stays signed in across app restarts.
					try { CookieManager.getInstance().flush(); } catch (Throwable ignored) {}
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

	/**
	 * Inject a watcher into every page that reports the currently-playing track
	 * to AndroidMedia. Title/artist/cover are read from the player's own DOM
	 * (the bottom bar / now-playing banner) because Android WebView does not
	 * reliably expose navigator.mediaSession.metadata back to script. Play
	 * state and position come from the <audio> element.
	 */
	private void injectMediaWatcher() {
		final String code =
			"(function(){try{" +
			"if(window.__csWatch)return;window.__csWatch=1;" +
			"function A(){return document.querySelector('audio');}" +
			"function tx(id,sel){var e=id?document.getElementById(id):null;" +
			"if(!e&&sel)e=document.querySelector(sel);" +
			"if(!e)return '';var t=(e.textContent||'').trim();" +
			"if(!t||t==='Nothing playing'||t==='\\u2014')return '';return t;}" +
			"function im(){var ids=['ctArt','npArt','playingArt','heroArt'];" +
			"for(var i=0;i<ids.length;i++){var e=document.getElementById(ids[i]);" +
			"if(e&&e.src&&e.src.indexOf('data:')!==0&&e.src.indexOf('icon.png')<0)return e.src;}return '';}" +
			"var lastT='',lastA='',lastArt='';" +
			"function meta(){try{" +
			"var t=tx('ctTitle','.playing__song__name')||tx('npTitle',null);" +
			"var ar=tx('ctArtist','.playing__song__artist')||tx('npArtist',null);" +
			"var g=im();" +
			"if(t&&window.AndroidMedia&&(t!==lastT||ar!==lastA||g!==lastArt)){" +
			"lastT=t;lastA=ar;lastArt=g;AndroidMedia.updateMetadata(t,ar,g);}" +
			"}catch(e){}}" +
			"function state(){try{var a=A();if(a&&window.AndroidMedia){" +
			"AndroidMedia.updatePlayback(!a.paused,Math.floor((a.currentTime||0)*1000),Math.floor((a.duration||0)*1000));}}catch(e){}}" +
			"function both(){meta();state();}" +
			// The page only defines window.CloudSongsControl inside its
			// setupMediaSession(), which bails out early because Android WebView
			// has no navigator.mediaSession. Install a working implementation
			// here that drives the player's real transport buttons, so the
			// notification / lock-screen controls actually do something.
			"function btn(){for(var i=0;i<arguments.length;i++){" +
			"var a=arguments[i];var e=a.charAt(0)==='.'?document.querySelector(a):document.getElementById(a);" +
			"if(e)return e;}return null;}" +
			"var PLAY=function(){return btn('npPlay','.current-track__actions .play');};" +
			"var NEXT=function(){return btn('npNext','ctNext');};" +
			"var PREV=function(){return btn('npPrev','ctPrev');};" +
			"if(!window.CloudSongsControl){window.CloudSongsControl={" +
			"toggle:function(){var b=PLAY();if(b){b.click();return;}var a=A();if(a){if(a.paused)a.play();else a.pause();}}," +
			"play:function(){var a=A();if(!a||a.paused)this.toggle();}," +
			"pause:function(){var a=A();if(a&&!a.paused)this.toggle();}," +
			"next:function(){var b=NEXT();if(b)b.click();}," +
			"prev:function(){var b=PREV();if(b)b.click();}," +
			"seek:function(ms){var a=A();if(a){try{a.currentTime=(ms||0)/1000;}catch(e){}}}" +
			"};}" +
			"document.addEventListener('play',both,true);" +
			"document.addEventListener('pause',both,true);" +
			"document.addEventListener('loadedmetadata',both,true);" +
			"document.addEventListener('durationchange',both,true);" +
			"setInterval(function(){var a=A();if(a&&a.src){meta();if(!a.paused)state();}},1000);" +
			"both();" +
			"}catch(e){}})();";
		js(code);
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

	// Keep audio + JS timers running while the app is in the background so the
	// song keeps playing (and the notification keeps updating) after you press
	// Home, switch apps, or lock the screen. We deliberately do NOT call
	// web.onPause(), which would suspend HTML5 media playback.
	@Override
	protected void onPause() {
		super.onPause();
		try { if (web != null) web.resumeTimers(); } catch (Throwable ignored) {}
		// Persist the signed-in session cookie to disk, otherwise the login (and
		// therefore the user's profile) is lost when the app is closed.
		try { CookieManager.getInstance().flush(); } catch (Throwable ignored) {}
	}

	@Override
	protected void onResume() {
		super.onResume();
		try { if (web != null) web.resumeTimers(); } catch (Throwable ignored) {}
		checkNotifStatus(false);
	}

	@Override
	public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
		super.onRequestPermissionsResult(requestCode, permissions, grantResults);
		if (requestCode == 2001) checkNotifStatus(true);
	}

	/** Surface, on-screen, whether the media notification can actually show.
	 *  If it's blocked, offer to open the system notification settings. */
	private void checkNotifStatus(boolean fromPrompt) {
		boolean enabled = true;
		try {
			NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
			if (nm != null) enabled = nm.areNotificationsEnabled();
		} catch (Throwable ignored) {}
		if (!enabled) {
			try {
				Toast.makeText(this,
						"Notifications are OFF — the now-playing notification can't show. Tap to enable.",
						Toast.LENGTH_LONG).show();
			} catch (Throwable ignored) {}
			// Take the user straight to this app's notification settings.
			try {
				Intent i;
				if (Build.VERSION.SDK_INT >= 26) {
					i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
							.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
				} else {
					i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
							.setData(Uri.parse("package:" + getPackageName()));
				}
				i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
				startActivity(i);
			} catch (Throwable ignored) {}
		} else if (fromPrompt) {
			try { Toast.makeText(this, "Notifications enabled \u2713", Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {}
		}
	}

	@Override
	protected void onDestroy() {
		if (sInstance == this) sInstance = null;
		// Do NOT stop the playback service here. While the app is merely
		// backgrounded (Home / lock / app switch) the Activity is kept alive and
		// the WebView keeps playing; the foreground service keeps the media
		// notification visible. The service tears itself down when playback
		// stops or the task is removed.
		super.onDestroy();
	}
}
