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
		// The tickle's only job is to wake us; we show the prompt regardless of
		// payload. The actual request details are fetched in-app after opening.
		showApprovalPrompt();
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
