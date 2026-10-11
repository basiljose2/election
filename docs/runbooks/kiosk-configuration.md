# Kiosk configuration guide (Voting Terminal)

The application protects the ballot screen (fullscreen guard, no context menu, no back
navigation, no stored choices), but the **operating system is the real kiosk boundary**. Set
the device up as below, then check it with the acceptance list at the end.

## All devices

- Wired power, battery saver off. Sleep, screen saver and screen lock **off**.
- Notifications, pop-ups, automatic updates and update restarts **off** during polling hours.
- Volume set so the ~2 s "vote recorded" beep is clearly audible (about 70%); headphones
  unplugged. The beep is the voter's confirmation.
- Date and time automatic; a known good Wi-Fi network plus the backup hotspot saved.
- The page to open is `https://<host>/terminal` (it redirects to `/terminal/pair` until the
  device is paired). Do not bookmark `/master` on a kiosk.
- One browser profile, used only for this purpose: no extensions, no password manager, no
  sync, no translate, no autofill.

## Windows (Edge kiosk via Assigned Access, preferred)

1. Create a local standard user `kiosk` (no admin rights, no password prompt at sign-in if the
   device is physically controlled).
2. Settings → Accounts → Other users → **Set up a kiosk** → choose `kiosk` → app
   **Microsoft Edge** → "As a digital sign / interactive display" is **not** wanted; choose
   "As a public browser" and set the URL above. Set "Reset after" to **never**.
3. Edge policies (Group Policy / registry) for that user: block `edge://` pages, disable
   InPrivate, disable developer tools, disable printing, disable translate, disable
   "Continue where you left off".

### Windows with Chrome instead

Launch (in a startup shortcut):

```
chrome.exe --kiosk --noerrdialogs --disable-infobars --disable-pinch
  --overscroll-history-navigation=0 --disable-session-crashed-bubble
  --autoplay-policy=no-user-gesture-required https://<host>/terminal
```

and block keyboard shortcuts at the OS level (Assigned Access or a keyboard filter): Alt+F4,
Alt+Tab, Win key, Ctrl+Alt+Del handling per your policy.

## Android tablet

1. Use a managed kiosk browser or Android's **screen pinning** with Chrome in fullscreen.
2. Settings: screen timeout **never** (or "stay awake while charging"), auto-rotate fixed to
   the orientation you use, gesture navigation off, notifications off (Do Not Disturb).
3. Chrome: site settings for the host allow **sound**; disable "Chrome Tips" and
   "Autofill".
4. Keep the tablet in a stand or case that blocks the hardware buttons from the voter.

## Per-election set-up at the booth

1. Open the page, enter the pairing code from the Master Terminal, check the **device id**
   shown on the kiosk matches the one the Presiding Officer sees, then the Presiding Officer
   confirms.
2. Tap **Activate** (Presiding Officer): the page enters fullscreen and plays a short test
   tone. Check the tone is audible.
3. The kiosk shows "Please wait for the Presiding Officer".

After a reload, restart or power loss the page needs **Activate** again (fullscreen and
audio need a tap). It never shows a ballot until then.

## Acceptance checks (do on each device type before polling day)

- [ ] Loading the page from cold shows the pairing or "Not activated" screen.
- [ ] After Activate it is fullscreen; pressing Esc shows the "Return to full screen" overlay.
- [ ] Long-press / right-click does nothing; pinch does nothing; the back gesture stays on
      the page.
- [ ] The test tone and (in a mock poll) the 2 s beep are audible at the voter's position.
- [ ] Pulling power and restarting returns to "Not activated" and nothing from a previous
      ballot is visible.
- [ ] The screen does not dim or lock during 30 minutes of inactivity.
