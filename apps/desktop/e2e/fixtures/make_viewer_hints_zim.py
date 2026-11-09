"""Builds viewer-hints.zim for the desktop smoke run (apps/desktop/e2e/tauri-smoke.mjs): one page that
asks the browser to resolve, connect to or fetch hosts on its own through resource hints, which the CSP
does not govern. The sealed viewer must strip them; the smoke run's net log must not name any of them.

All content is written here by the SKEPI project and dedicated to the public domain (CC0-1.0). The
hosts are under example.com (reserved, RFC 2606). Writer: python-libzim, pinned in
tools/rag-eval/requirements.txt, run once on a developer machine; nothing from it ships in the app.

    python -m venv .venv && .venv/Scripts/python -m pip install libzim==3.10.0
    .venv/Scripts/python make_viewer_hints_zim.py
"""

from __future__ import annotations

import pathlib
import shutil

from libzim.writer import Creator, Hint, Item, StringProvider

OUT = pathlib.Path(__file__).resolve().parent / "viewer-hints.zim"

PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Resource hints</title>
<link rel="preconnect" href="https://skepi-hint-preconnect.example.com">
<link rel="dns-prefetch" href="//skepi-hint-dns-prefetch.example.com">
<link rel="prefetch" href="https://skepi-hint-prefetch.example.com/next.html">
<link rel="prerender" href="https://skepi-hint-prerender.example.com/">
<link rel="preload" as="image" href="https://skepi-hint-preload.example.com/i.png">
<link rel="modulepreload" href="https://skepi-hint-modulepreload.example.com/m.js">
<link rel="pre&#99;onnect" href="https://skepi-hint-entity.example.com">
<link title="a>b" rel="preconnect" href="https://skepi-hint-quoted.example.com">
</head><body>
<noscript><link rel="preconnect" href="https://skepi-hint-noscript.example.com"></noscript>
<h1>Resource hints</h1>
<p>This page asks for connections to hosts it must never reach.</p>
</body></html>
"""


class Page(Item):
    def get_path(self) -> str:
        return "Resource_hints"

    def get_title(self) -> str:
        return "Resource hints"

    def get_mimetype(self) -> str:
        return "text/html"

    def get_contentprovider(self) -> StringProvider:
        return StringProvider(PAGE)

    def get_hints(self) -> dict[Hint, bool]:
        return {Hint.FRONT_ARTICLE: True, Hint.COMPRESS: True}


def main() -> None:
    if OUT.exists():
        OUT.unlink()
    with Creator(str(OUT)).config_indexing(False, "eng") as creator:
        creator.set_mainpath("Resource_hints")
        for key, value in {
            "Name": "skepi_viewer_hints",
            "Title": "SKEPI viewer resource hints",
            "Description": "Test fixture: resource hints in a sealed article",
            "Language": "eng",
            "Creator": "SKEPI",
            "Publisher": "SKEPI",
            "Date": "2026-11-09",
            "License": "CC0-1.0",
        }.items():
            creator.add_metadata(key, value)
        creator.add_item(Page())
    for leftover in OUT.parent.glob(f"{OUT.name}_*"):
        shutil.rmtree(leftover) if leftover.is_dir() else leftover.unlink()
    print(f"{OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
