package com.cloudsongs.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Receives the content-free "tickle" that tells this device a sign-in is waiting
 * for approval, even when the app is closed. The APK's WebView has no Web Push,
 * so this native FCM channel is how a closed app hears about it.
 *
 * The message carries no account data (matching the Web Push design): it only
 * says "something is waiting". We raise a heads-up notification that opens the
 * app; MainActivity's approval poll then shows the Approve / Deny pop-up. On a
 * fresh token we hand it to MainActivity so it can be registered against the
 * signed-in account through the JS bridge.
 */
public class CloudSongsFirebaseService extends FirebaseMessagingService {

	static final String CHANNEL = "cloudsongs_approval";
	static final int NOTIF_ID = 71;

	// Suggestions live on their own channel and id, so a user who mutes "Listen
	// to this" nudges still receives sign-in approval alerts - those are a
	// security feature and must never be collateral damage.
	static final String CHANNEL_SUGGEST = "cloudsongs_suggest";
	static final int NOTIF_ID_SUGGEST = 72;

	@Override
	public void onNewToken(String token) {
		super.onNewToken(token);
		// Remember it; MainActivity registers it with the server once the page
		// (and therefore the signed-in session) is available.
		try {
			getSharedPreferences("cs", Context.MODE_PRIVATE)
					.edit().putString("fcm_token", token).apply();
		} catch (Throwable ignored) {}
		// If the app happens to be open, register immediately.
		try { MainActivity.registerFcmToken(token); } catch (Throwable ignored) {}
	}

	@Override
	public void onMessageReceived(RemoteMessage message) {
		super.onMessageReceived(message);
		String kind = "";
		String title = "", body = "", songId = "";
		try {
			java.util.Map<String, String> d = message.getData();
			if (d != null) {
				if (d.get("kind") != null) kind = d.get("kind");
				if (d.get("title") != null) title = d.get("title");
				if (d.get("body") != null) body = d.get("body");
				if (d.get("songId") != null) songId = d.get("songId");
			}
		} catch (Throwable ignored) {}

		if ("suggest".equals(kind)) {
			showSuggestion(title, body, songId);
			return;
		}
		// Anything else is the approval tickle, which carries no content.
		showApprovalPrompt();
	}

	/** A "listen to this" nudge. Tapping it opens the player on that song. */
	private void showSuggestion(String title, String body, String songId) {
		NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		if (nm == null) return;

		if (Build.VERSION.SDK_INT >= 26) {
			NotificationChannel ch = new NotificationChannel(CHANNEL_SUGGEST, "Listening suggestions",
					NotificationManager.IMPORTANCE_DEFAULT);
			ch.setDescription("Occasional ideas for something to play. Safe to turn off.");
			ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
			nm.createNotificationChannel(ch);
		}

		Intent open = new Intent(this, MainActivity.class);
		open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
		if (songId != null && songId.length() > 0) open.putExtra("cs_song", songId);
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		// A distinct request code, so this does not overwrite the approval intent.
		PendingIntent pi = PendingIntent.getActivity(this, 2, open, flags);

		Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
				? new Notification.Builder(this, CHANNEL_SUGGEST) : new Notification.Builder(this);
		b.setSmallIcon(android.R.drawable.ic_media_play)
				.setContentTitle(title == null || title.length() == 0 ? "Listen to this" : title)
				.setContentText(body == null ? "" : body)
				.setAutoCancel(true)
				.setVisibility(Notification.VISIBILITY_PUBLIC)
				.setContentIntent(pi);
		if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_DEFAULT);

		try { nm.notify(NOTIF_ID_SUGGEST, b.build()); } catch (Throwable ignored) {}
	}

	private void showApprovalPrompt() {
		NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		if (nm == null) return;

		if (Build.VERSION.SDK_INT >= 26) {
			NotificationChannel ch = new NotificationChannel(CHANNEL, "Sign-in approvals",
					NotificationManager.IMPORTANCE_HIGH);
			ch.setDescription("Approve or deny new sign-ins to your account.");
			ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
			nm.createNotificationChannel(ch);
		}

		Intent open = new Intent(this, MainActivity.class);
		open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);

		Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
				? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
		b.setSmallIcon(android.R.drawable.ic_lock_idle_lock)
				.setContentTitle("Approve sign-in to Cloud Songs?")
				.setContentText("Someone signed in with your password. Tap to review.")
				.setAutoCancel(true)
				.setVisibility(Notification.VISIBILITY_PUBLIC)
				.setContentIntent(pi);
		if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH);

		try { nm.notify(NOTIF_ID, b.build()); } catch (Throwable ignored) {}
	}
}
