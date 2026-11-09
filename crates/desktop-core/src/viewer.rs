//! The sealed article viewer's `zim://` protocol (desktop counterpart of `ZimSchemeHandler.kt`).
//! WebView2 serves custom schemes as `http://zim.localhost/<archiveId>/<path>`, so the CSP names
//! `'self'` (the zim origin) where Android names `zim:`. Every response, 403 and 404 included,
//! carries the CSP and the other security headers; anything that is not a valid in-archive path is
//! refused and logged. The viewer webview itself has no IPC capability and no network (see
//! apps/desktop/src-tauri/src/viewer.rs).

use percent_encoding::percent_decode_str;
use regex::Regex;
use std::sync::LazyLock;

/// Desktop CSP: no script, no connections, no frames, no forms; `sandbox` (without `allow-scripts`)
/// also disables scripts, plugins, popups and top-level navigation even if a pack's HTML asks.
pub const CSP: &str = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox";

pub const SECURITY_HEADERS: &[(&str, &str)] = &[
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    // Chromium resolves <link rel=dns-prefetch> hosts outside the CSP; resource hints are also stripped.
    ("X-DNS-Prefetch-Control", "off"),
];

/// `<link rel>` values that make the browser resolve, connect to or fetch a host on its own, before
/// (and outside) any request the CSP governs.
const RESOURCE_HINTS: [&str; 6] = ["preconnect", "dns-prefetch", "prefetch", "prerender", "preload", "modulepreload"];

/// Removes every resource-hint `<link>` from a page. The page is parsed as the viewer's browser parses
/// it (HTML5 tree builder, scripting off, so `<noscript>` content counts, entities decoded); a page
/// without hints keeps its bytes. Returns None when nothing was removed.
pub fn strip_resource_hints(html: &str) -> Option<String> {
    use html5ever::tendril::TendrilSink;
    use html5ever::tree_builder::TreeBuilderOpts;
    if !html.to_ascii_lowercase().contains("link") {
        return None;
    }
    let opts =
        html5ever::ParseOpts { tree_builder: TreeBuilderOpts { scripting_enabled: false, ..Default::default() }, ..Default::default() };
    let mut doc = html5ever::parse_document(scraper::HtmlTreeSink::new(scraper::Html::new_document()), opts).one(html);
    let hints: Vec<_> = doc
        .tree
        .nodes()
        .filter(|n| {
            n.value().as_element().is_some_and(|e| {
                e.name().eq_ignore_ascii_case("link")
                    && e.attr("rel")
                        .is_some_and(|rel| rel.split_ascii_whitespace().any(|t| RESOURCE_HINTS.iter().any(|h| t.eq_ignore_ascii_case(h))))
            })
        })
        .map(|n| n.id())
        .collect();
    if hints.is_empty() {
        return None;
    }
    for id in hints {
        if let Some(mut node) = doc.tree.get_mut(id) {
            node.detach();
        }
    }
    Some(doc.html())
}

/// Blackout theme (same CSS as Android).
pub const DARK_CSS: &str = "html,body{background:#000!important;color:#e5e7eb!important}*{background-color:transparent!important;color:inherit!important;border-color:#525252!important}a,a:visited{color:#93c5fd!important}img,video{opacity:.8}";

static HEAD_OPEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<head(\s[^>]*)?>").expect("regex"));
static ARCHIVE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-fA-F-]{8,64}$").expect("regex"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub archive_id: String,
    pub path: String,
}

fn is_dot_segment(s: &str) -> bool {
    s == "." || s == ".."
}

/// Parses the path part of a viewer URL (`/<archiveId>/<percent-encoded ZIM path>`). ZIM paths are
/// flat keys: NULs and any dot segment (raw, percent-encoded, double-encoded or backslash
/// separated) are refused, like on Android.
pub fn parse_path(raw: &str) -> Option<Target> {
    let rest = raw.strip_prefix('/')?;
    let (archive, path_enc) = rest.split_once('/')?;
    if !ARCHIVE_ID.is_match(archive) || path_enc.is_empty() {
        return None;
    }
    let path = percent_decode_str(path_enc).decode_utf8().ok()?.into_owned();
    if path.is_empty() || path.contains('\0') {
        return None;
    }
    for seg in path.split(['/', '\\']) {
        if is_dot_segment(seg) {
            return None;
        }
        let once = percent_decode_str(seg).decode_utf8_lossy();
        if is_dot_segment(&once) || is_dot_segment(&percent_decode_str(&once).decode_utf8_lossy()) {
            return None;
        }
    }
    Some(Target { archive_id: archive.to_ascii_lowercase(), path })
}

/// Splits `text/html; charset=utf-8` into the lower-cased type and the charset (utf-8 for text/*).
pub fn split_mime(mime: &str) -> (String, Option<String>) {
    let mut parts = mime.split(';').map(str::trim);
    let ty = parts.next().unwrap_or("").to_ascii_lowercase();
    let charset = parts
        .find_map(|p| p.get(..8).filter(|k| k.eq_ignore_ascii_case("charset=")).map(|_| p[8..].trim_matches('"').to_owned()))
        .or_else(|| ty.starts_with("text/").then(|| "utf-8".to_owned()));
    (ty, charset)
}

/// Defence in depth: the CSP (and DNS prefetch off) also travel inside the document, resource hints
/// are removed; the blackout CSS follows.
pub fn inject_head(html: &[u8], dark: bool) -> Vec<u8> {
    let decoded = String::from_utf8_lossy(html);
    let stripped = strip_resource_hints(&decoded);
    let text = stripped.as_deref().unwrap_or(&decoded);
    let mut meta = format!(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">"
    );
    if dark {
        meta.push_str(&format!("<style id=\"skepi-dark\">{DARK_CSS}</style>"));
    }
    match HEAD_OPEN.find(&text) {
        Some(m) => format!("{}{}{}", &text[..m.end()], meta, &text[m.end()..]).into_bytes(),
        None => format!("{meta}{text}").into_bytes(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerResponse {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ViewerResponse {
    fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        let headers = SECURITY_HEADERS.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Self { status, content_type: content_type.to_owned(), headers, body }
    }

    pub fn forbidden() -> Self {
        Self::new(403, "text/plain; charset=utf-8", Vec::new())
    }

    pub fn not_found() -> Self {
        Self::new(404, "text/plain; charset=utf-8", Vec::new())
    }

    pub fn ok(mime: &str, body: Vec<u8>, dark: bool) -> Self {
        let (ty, charset) = split_mime(mime);
        let content_type = match &charset {
            Some(c) => format!("{ty}; charset={c}"),
            None => ty.clone(),
        };
        let body = if ty == "text/html" { inject_head(&body, dark) } else { body };
        Self::new(200, &content_type, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0f2c3e4a-1b2c-4d5e-8f90-123456789abc";

    #[test]
    fn parses_archive_and_decoded_path() {
        assert_eq!(
            parse_path(&format!("/{ID}/A/Water%20(molecule)")),
            Some(Target { archive_id: ID.into(), path: "A/Water (molecule)".into() })
        );
        assert_eq!(parse_path(&format!("/{ID}/Canberra")).map(|t| t.path), Some("Canberra".into()));
    }

    #[test]
    fn rejects_traversal_and_malformed_urls() {
        for bad in [
            format!("/{ID}/../secret"),
            format!("/{ID}/A/../../x"),
            format!("/{ID}/%2e%2e/x"),
            format!("/{ID}/%252e%252e/x"),
            format!("/{ID}/A\\..\\x"),
            format!("/{ID}/A%5C..%5Cx"),
            format!("/{ID}/a%00b"),
            format!("/{ID}/"),
            format!("/{ID}"),
            "/not-an-id!/x".to_owned(),
            "/../etc/passwd".to_owned(),
            String::new(),
            format!("/{ID}/%ff%fe"),
        ] {
            assert_eq!(parse_path(&bad), None, "{bad}");
        }
    }

    #[test]
    fn every_response_carries_the_csp() {
        for r in [ViewerResponse::forbidden(), ViewerResponse::not_found(), ViewerResponse::ok("image/png", vec![1, 2], false)] {
            assert!(r.headers.iter().any(|(k, v)| k == "Content-Security-Policy" && v == CSP), "{}", r.status);
            assert!(r.headers.iter().any(|(k, v)| k == "X-Content-Type-Options" && v == "nosniff"));
        }
        assert!(!CSP.contains("script-src") && CSP.contains("default-src 'none'") && CSP.contains("sandbox"));
    }

    /// Every way a page can ask the browser to resolve or contact a host before any request the CSP sees.
    const HINTS: &str = concat!(
        "<html><head><title>t</title>",
        "<link rel=preconnect href=https://hint-a.example>",
        "<link rel=\"DNS-Prefetch\" href=//hint-b.example>",
        "<link title=\"x>y\" rel='stylesheet prefetch' href=https://hint-c.example/s.css>",
        "<link rel=prerender href=https://hint-d.example/>",
        "<link rel=preload as=image href=https://hint-e.example/i.png>",
        "<link rel=modulepreload href=https://hint-f.example/m.js>",
        "<link rel=\"pre&#99;onnect\" href=https://hint-g.example>",
        "<link rel=stylesheet href=style.css>",
        "</head><body><noscript><link rel=preconnect href=https://hint-h.example></noscript>",
        "<p>text</p></body></html>"
    );

    #[test]
    fn resource_hints_never_reach_the_browser() {
        let r = ViewerResponse::ok("text/html", HINTS.as_bytes().to_vec(), false);
        let body = String::from_utf8(r.body).expect("utf8");
        assert!(!body.contains("hint-"), "a resource hint survived: {body}");
        assert!(body.contains("style.css") && body.contains("<p>text</p>"), "ordinary content stays: {body}");
        assert!(body.contains("<meta http-equiv=\"Content-Security-Policy\""));
        assert!(body.contains("<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">"));
        assert!(r.headers.iter().any(|(k, v)| k == "X-DNS-Prefetch-Control" && v == "off"));
        // A page without hints keeps its bytes (only the head injection changes it).
        let plain = b"<html><head><link rel=stylesheet href=a.css></head><body>b</body></html>";
        let kept = String::from_utf8(ViewerResponse::ok("text/html", plain.to_vec(), false).body).expect("utf8");
        assert!(kept.ends_with("<link rel=stylesheet href=a.css></head><body>b</body></html>"), "{kept}");
    }

    #[test]
    fn html_gets_the_meta_csp_and_optional_dark_css() {
        let r = ViewerResponse::ok("text/html", b"<html><head><title>x</title></head><body>b</body></html>".to_vec(), true);
        let body = String::from_utf8(r.body).expect("utf8");
        assert!(body.starts_with("<html><head><meta http-equiv=\"Content-Security-Policy\""));
        assert!(body.contains("skepi-dark"));
        assert_eq!(r.content_type, "text/html; charset=utf-8");
        let plain = ViewerResponse::ok("text/html", b"<p>no head</p>".to_vec(), false);
        assert!(String::from_utf8(plain.body).expect("utf8").starts_with("<meta http-equiv"));
    }

    #[test]
    fn mime_split() {
        assert_eq!(split_mime("text/html; charset=\"UTF-8\""), ("text/html".into(), Some("UTF-8".into())));
        assert_eq!(split_mime("image/svg+xml"), ("image/svg+xml".into(), None));
        assert_eq!(split_mime("text/css"), ("text/css".into(), Some("utf-8".into())));
    }
}
