# Troubleshooting

## Messages won't send, or no reply comes

Check the host status at the bottom of the chat list.

- **This phone**: open the engine page and check its status and **Logs**. Not installed, stopped and failed to start are different cases; follow the page. When a start fails, the failure card links to the logs and a diagnostics bundle.
- **Remote host**: the remote hosts page offers a fix for the cause, such as **Reconnect**, **Sign in again** or **Trust again**.
- If no model is set up, **Choose model** offers to enter an API key or add a provider.

Reset and uninstall both delete data on this phone; you rarely need them to fix a problem.

<!-- nav: commonSettings,phoneEngineDiagnostics -->
`Settings › Diagnostics` · [Open](dshgo://open/diagnostics)

To report a problem, export a diagnostics bundle here. It includes the version, device, logs and the latest crash, never keys or tokens.

To let the AI look into it: tap **Let the AI read diagnostics**. The app writes the same (redacted) snapshot into the engine, then ask the AI to "check the diagnostics" — the bundled `dsh-go-support` skill walks the symptoms and drafts an issue you can paste.

## The engine stops in the background, or notifications don't arrive

<!-- nav: commonSettings,phoneEngineKeepAlive -->
`Settings › Background running` · [Open](dshgo://open/background)

The system suspends the app soon after it leaves the screen: a running chat may go on for a short while, as long as the system allows, then pauses with the app and tries to pick up when you come back. Some versions can ask for a long-running task, so the chat goes on in the background with a notice in the notification bar; if the system says no or takes it back, it pauses the same way. This page says which your version is.

To keep it going, keep the app on screen, or run it on a connected remote host. HarmonyOS has no battery-optimization or lock-in-Recents steps to try.

Alerts need the app running, and none go out while it's suspended; also turn on the alerts you want in the app's **Notifications** and allow DSH Go notifications in system settings. Scheduled tasks on this phone only fire while the app is running too, and won't run on time while it's suspended.

## The engine keeps failing to start

After several unclean exits in a row the engine won't start by itself and waits for you. The cause isn't known: the system may have reclaimed the app, or the app was closed, or the engine hit an error. On the failure card:

- **Restore configuration**: goes back to the plugins and settings of the last good run. A run counts as good after two minutes without stopping; with no such record, or nothing changed since, the button isn't there. It only restores configuration: it doesn't go back to an older engine, and it leaves chats and scheduled tasks alone.
- **Enter Safe mode**: starts with the default configuration that comes with the app, without the plugins you installed. Your chats stay. Once fixed, tap **Return to normal mode**. Web settings changed in Safe mode aren't kept.
- **Retry**: starts again with the configuration as it is.

If the engine has already started since the app opened, restoring and entering or leaving Safe mode reopen the app; the dialog says so. The failure card also links to the logs and a diagnostics bundle. Reset and uninstall both delete data on this phone; you rarely need them to fix a problem.

## System actions don't work

The top of the system actions page says where things stand:

- **On, waiting for the local engine**: start the local engine.
- **On, works once you're back in DSH Go**: the system doesn't let background apps do these, so come back to DSH Go.
- **On, can't connect right now, retrying**: give it a moment.
- **Not available in this version**: this version doesn't support system actions.
- **You're connected to a remote host**: switch to **This phone**.

If the AI says it isn't supported: with system actions, seeing the screen, tapping inside other apps, reading the clipboard, finding apps by name and SMS can't be done. Alarms and timers need a version with system reminders. See [Phone control](04-phone-control.md).

## Screen control doesn't work

Seeing the screen and tapping inside other apps is screen control, which needs the phone's debug interface. Ask the AI to check the phone debug channel:

- No debug port: turn on Wireless debugging in developer options and leave it on.
- Timed out or refused: the phone asks whether to allow debugging the first time; choose Always allow. If no dialog appears, revoke the debugging authorisation in developer options and try again.
- A new phone, or a revoked authorisation: approve it once more.

See [Phone control](04-phone-control.md). The real-time log on the local engine page names the step too.

## The pet is gone

- Not in chats: if the pet page is set to **None**, choose a pet; if it's hidden for an hour, tap **Show now**.
- Not outside the app: HarmonyOS can't show the pet outside the app; it stays in the app.

See [Pets](06-pets.md).

## A plugin is installed but doesn't show up

Check that the plugin is enabled, and restart the engine if asked. A plugin's native UI needs the dsh-go bridge on the host: this phone's engine has it built in, remote hosts usually don't. A display place may also be turned off in the plugin's details. Plugin panels without a native UI appear in the Plugins group of All features, opening in the app or as Web entries. See [Plugins](08-plugins.md).

## What the app sends

<!-- nav: commonSettings,hubPrivacy,usageStatsTitle -->
`Settings › Privacy and sharing › Send anonymous usage stats` · [Open](dshgo://open/usage-stats)

Usage statistics aren't sent on HarmonyOS for now. The switch is off and locked, and neither the welcome screen nor an upgrade notice offers it.

## The guide doesn't match what I see

Check the app version under **Version** in Settings and compare it with the version in the [guide index](../README.md). The app is always right.
