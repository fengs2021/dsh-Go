# Phone control

HarmonyOS gives the AI two ways to act on the phone:

- System actions: a switch in the app that uses public system APIs to open apps and system pages, send notifications, write the clipboard and hand your own steps back to you.
- Screen control: the local engine's own debug channel, which reads the current screen, taps, types, swipes, presses keys and takes screenshots, in third-party apps too.

System actions need only the switch. Screen control needs you to turn on wireless debugging in developer options, and to approve this app once in a system dialog. Both work only in the local engine's chats, not while you're connected to a remote host.

## Turning on system actions

<!-- nav: commonSettings,systemActionsTitle -->
`Settings › System actions` · [Open](dshgo://open/system-actions)

Turn on the switch at the top of the page. The first time, it explains what it can do, when, who gets the results, what it never does and how to stop; tap **Agree**. You can also pick it when choosing permissions the first time you open the app.

Once on, the top of the page says where things stand; if it isn't working, see [FAQ](11-faq.md). Turn it off here anytime.

## What system actions can do

- Open an app or link: apps by package name, not by display name.
- Calendar, dialer, share, navigation: opens the system page; the last step is yours.
- Some system settings pages: mobile network, display, sound, NFC and this app's notifications.
- Send a notification: sending it doesn't mean you've seen it.
- Write the clipboard: write only, never read.
- Alarms and timers: where this version has system reminders, they're listed under What it can do. The system reminds you when it's time, and the engine doesn't run for it. The system can still say no, for example if the service isn't turned on or it's at its limit, and the AI is told.
- Hand back to you: you do steps like sign-in or codes, then press **Continue**.

## What system actions can't do

- See the screen or tap inside other apps: screen control, below, does that.
- Read the clipboard, find apps by name, SMS: no reliable public API; the AI is told it's not supported.
- Alarms and timers, on a version or device without system reminders: What it can't do says so.

## Screen control: approving it the first time

Screen control uses the phone's own debug interface (HDC). The local engine reaches it from inside the app, with no cable and no computer, but the phone has to have debugging on and has to trust this app once:

1. Turn on developer options: Settings → About phone, tap Build number until it says you're a developer. Skip this if developer options are already there.
2. Settings → System → Developer options: turn on Wireless debugging and leave it on. No computer and no pairing code needed.
3. Back in a local engine chat in DSH Go, ask the AI to check the phone channel, for example "check the phone debug channel". The phone asks whether to allow debugging the first time; choose Always allow.
4. No dialog: revoke the debugging authorisation in developer options and try again; if that doesn't help, turn Wireless debugging off and on.

One approval lasts. A new phone, or a revoked authorisation, means doing it again.

## What screen control can do

- Read the current screen: the position and text of every control, so the AI looks first instead of tapping blind.
- Tap, long-press, swipe and press keys, including Back, Home and waking the screen.
- Type text: Chinese input brings up the system paste button and the AI taps Paste first.
- Take a screenshot and look at it.
- Start and stop apps, list installed apps and what they expose: by package name.
- Run system commands: uitest, bm, aa and the like, as the debug shell.

It can't: read the clipboard, read SMS, get past passwords and codes, sign in to an app for you, work with the screen off, or get around an app's own limits.

## Screen control and privacy

- While approved, it can see what's on screen, including inside other apps; that stays in the chat.
- To stop it: turn off Wireless debugging in developer options, or revoke the debugging authorisation there, and screen control stops at once. Turn system actions off on their page.
- Every step follows the chat's permissions; see Confirmation below.

## Confirmation

**Confirmation** is always **Follows permissions**, with nothing else to pick: it follows the chat's permissions, so it usually asks each time, and not with full access. For permissions, see Permissions in [Settings](10-settings.md). The last step of a call, a share or a calendar event is always yours, in the system page.

## Only with DSH Go on screen

The system doesn't let background apps do these. After the AI opens another app, it can't go on until you're back in DSH Go. Screen control also needs the screen on: it stops when the screen goes off.

## Your turn

When **Your turn** appears, do the step, come back to DSH Go and press **Continue**. That only says you confirmed; the AI can't see what happened in other apps. To end it, press **Stop**.

## Results and the log

Results go back to the chat and to the model you chose. They describe the system call: a page that opened doesn't mean the thing is done, and if the result is unknown the call may have gone out, it won't retry on its own, and it's worth checking yourself.

**Recent actions** at the bottom of the page records what ran and how it ended, not the content.
