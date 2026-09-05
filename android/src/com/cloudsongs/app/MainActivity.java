package com.cloudsongs.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Cloud Songs Android shell: a full-screen WebView pointed at the live site.
 * Keeps sessions (cookies + DOM storage), allows audio playback without a tap,
 * supports the file picker (for the profile photo upload), and wires the
 * hardware Back button to in-app history.
 */
public class MainActivity extends Activity {

	private static final String APP_URL = "https://abinash-songs.pages.dev/";
	private static final int FILE_REQ = 1001;

	private WebView web;
	private ValueCallback<Uri[]> filePathCallback;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		web = new WebView(this);
		web.setLayoutParams(new ViewGroup.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

		WebSettings s = web.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setDatabaseEnabled(true);
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setLoadWithOverviewMode(true);
		s.setUseWideViewPort(true);
		s.setSupportZoom(false);

		CookieManager.getInstance().setAcceptCookie(true);
		CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

		web.setWebViewClient(new WebViewClient());
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

		setContentView(web);

		if (savedInstanceState != null) {
			web.restoreState(savedInstanceState);
		} else {
			web.loadUrl(APP_URL);
		}
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
