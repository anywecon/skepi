# S.K.E.P.I. Privacy Policy

Effective date: 2026-10-12. Applies to the S.K.E.P.I. app for Android (package `org.skepi.app`) and the S.K.E.P.I.
desktop app for Windows, from every distribution channel (GitHub Releases, F-Droid, Google Play).

## Intended purpose

S.K.E.P.I. is for general reference and education only. It is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Consult a healthcare professional for medical advice. In an emergency, call 112 or your local emergency number.

## Summary

S.K.E.P.I. collects no personal data. It has no accounts, no analytics, no advertising, no crash reporting and
no telemetry. Nothing you type, read or ask leaves your device. The app connects to the internet only
when you start a download.

## What the app does not do

- It does not collect, store on a server, sell or share any personal or device data.
- It contains no advertising, analytics, tracking or crash-reporting libraries, and no Google Play
  Services or Firebase.
- It makes no network connection in the background, at startup or on a schedule.

## Network use

The app uses the network in two cases, both started by you:

1. **Downloading content.** When you choose a content pack (offline encyclopedia, maps, places, AI model)
   or check for a newer list of packs, the app downloads the file from the HTTPS host named in the
   signed catalog. Today these are `download.kiwix.org` (Kiwix), `huggingface.co` (Hugging Face) and
   `github.com` (GitHub Releases); a later signed catalog may name others. The request contains only the file
   address and a generic user agent: no account, device identifier, query string or personal data. As
   with any download, the host receives your IP address; those hosts are run by third parties under their
   own privacy policies. Android downloads go through the system Download Manager.
2. **Sharing on your local network.** When you share or receive packs with another phone (Wi-Fi or a local
   hotspot, paired by QR code) or with a S.K.E.P.I. desktop in Station mode, the devices connect directly to
   each other over the local network; packs travel encrypted with TLS. Nothing goes to the internet. If
   you choose to share the app itself, the sending phone serves the app file on the local network (plain
   HTTP, with the signing fingerprint shown for checking) only while you share.

## Data kept on your device

- Installed content packs and a small encrypted database (SQLCipher) with the list of installed packs,
  your settings and battery-cost measurements. The database key is kept in the device's secure storage
  (Android Keystore; on Windows, protected with DPAPI).
- Problem reports you save (see below).

This data never leaves the device through the app. Uninstalling the app, or clearing its storage,
deletes it. The Android app opts out of cloud backup, so none of it is copied to a backup service.

## Permissions (Android)

| Permission | Used for | When |
| --- | --- | --- |
| Internet, network state | Downloading packs you choose | Only during a download you started |
| Location (precise and approximate, foreground only) | Showing your position and direction on the offline map, and your coordinates in Tools | Asked when you press "My location"; used only while the map is open (or when you ask in Tools), never in the background, never stored, logged or sent |
| Camera | Scanning the pairing QR code of another device | Only while the QR scanner is open; no photos are taken or saved |
| Nearby Wi-Fi devices, Wi-Fi and network state changes | Creating or joining a local hotspot to share packs between phones | Only while you share or receive; not used to find your location |

The SOS torch needs no permission. Calls and text messages are handed to your phone's dialer or
messaging app; S.K.E.P.I. never sends them itself.

## Problem reports

"Report a problem with this answer" prepares a text with the question, the answer shown, the cited
sources, the app version and what you write about the problem. S.K.E.P.I. sends nothing itself. On Android,
"Send…" opens your phone's share menu with that text: you choose the app (e-mail, messaging, a browser
for GitHub issues) and whether to send. You can also copy the text or save it on the device. We receive
only what you choose to send, through the channel you choose.

## Children

S.K.E.P.I. is not directed at children and collects no data from anyone.

## Changes

Changes to this policy are published in this file, with a new effective date. The history of every change
is public in the project's Git repository.

## Contact

Open an issue at <https://github.com/anywecon/skepi/issues>. For security matters, use GitHub's private
vulnerability reporting as described in `SECURITY.md`.
