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
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * Cloud Songs Android shell: a full-screen WebView pointed at the live site.
 * Written defensively so a WebView/provider hiccup shows a message instead of
 * crashing the app.
 */
public class MainActivity extends Activity {

	private static final String APP_URL = "https://abinash-songs.pages.dev/";
	private static final int FILE_REQ = 1001;

	private WebView web;
	private FrameLayout root;
	private ValueCallback<Uri[]> filePathCallback;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		root = new FrameLayout(this);
		root.setBackgroundColor(Color.parseColor("#121212"));   // no white flash
		root.setLayoutParams(new ViewGroup.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		setContentView(root);

		// Android 13+ needs this granted for the media-playback notification to show.
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

			web.setWebViewClient(new WebViewClient() {
				@Override
				public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
					// Only replace the page on a main-frame failure, not sub-resources.
					if (Build.VERSION.SDK_INT >= 21 && request != null && request.isForMainFrame()) {
						showError();
					}
				}
			});
			web.setWebChromeClient(new WebChromeClient() {
				@Override
				public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
					filePathCallback = cb;
					try {
						startActivityForResult(params.createIntent(), FILE_REQ);
					} catch (Exception e) {
						filePathCallback = null;
						return false;
					}
					return true;
				}
			});

			if (savedInstanceState != null) {
				web.restoreState(savedInstanceState);
			} else {
				web.loadUrl(APP_URL);
			}
		} catch (Throwable t) {
			showError();
		}
	}

	private void showError() {
		TextView tv = new TextView(this);
		tv.setText("Couldn't load Cloud Songs.\nCheck your internet connection and reopen the app.");
		tv.setTextColor(Color.WHITE);
		tv.setTextSize(16);
		tv.setPadding(48, 48, 48, 48);
		FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
		lp.gravity = android.view.Gravity.CENTER;
		if (root != null) { root.removeAllViews(); root.addView(tv, lp); }
	}

	@Override
	protected void onActivityResult(int requestCode, int resultCode, Intent data) {
		if (requestCode == FILE_REQ) {
			Uri[] result = null;
			if (resultCode == RESULT_OK && data != null && data.getData() != null) {
				result = new Uri[]{ data.getData() };
			}
			if (filePathCallback != null) filePathCallback.onReceiveValue(result);
			filePathCallback = null;
		} else {
			super.onActivityResult(requestCode, resultCode, data);
		}
	}

	@Override
	public boolean onKeyDown(int keyCode, KeyEvent event) {
		if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
			web.goBack();
			return true;
		}
		return super.onKeyDown(keyCode, event);
	}

	@Override
	protected void onSaveInstanceState(Bundle outState) {
		super.onSaveInstanceState(outState);
		if (web != null) web.saveState(outState);
	}
}
