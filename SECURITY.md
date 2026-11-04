# Security policy

S.K.E.P.I. is a Developer Preview (`v0.2.1-preview`). Security reports are welcome and handled privately.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on <https://github.com/Fiouri/skepi> (a private security
advisory, visible only to you and the maintainers). Please include:

- the affected app and version (About screen), platform and device;
- what an attacker needs (a malicious ZIM, GGUF, PMTiles or places pack, a phone on the same network, a
  modified catalog, …) and what they gain;
- steps to reproduce, ideally with a minimal file.

We aim to acknowledge a report within 7 days and to agree on a disclosure date with you; fixes are
released before the advisory is published.

## Scope

In scope: both apps (Android, Windows), the article viewers (sealing), the signed catalog and pack
verification, downloads, P2P sharing and Station mode, the on-device AI pipeline (source sanitizer,
citation validation), the release signing and build guards. The threat model, with what each defence
covers and the known residual risks, is in [`docs/threat-model.md`](docs/threat-model.md).

Out of scope: the content of the official packs (report errors in Wikipedia articles to Wikipedia, in
map data to OpenStreetMap), vulnerabilities in the Microsoft WebView2 Runtime or Android WebView
themselves (report them to Microsoft or Google), and attacks that need a rooted phone or an
administrator account on the computer.

## Verifying releases

Release files are listed with their SHA-256 in `SHA256SUMS.txt` on the release page. Android release
APKs are signed with the SKEPI release key, certificate SHA-256
`7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e`. The Windows installers of the
preview are not code-signed. The content catalog is signed offline (Ed25519); the apps pin its public
keys.
