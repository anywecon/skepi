//! Article HTML -> `{ heading, level, text }[]`, rule for rule as `ZimContent.extractSections` in
//! modules/expo-zim (jsoup 1.23.2 on the phone), so the passages the desktop ranks are the ones the
//! phone ranks (retrieval parity). `jsoup_text` mirrors jsoup's `Element.text()`: whitespace
//! normalisation, separators around block / text-boundary elements and `<br>`, `<pre>` kept verbatim.

use ego_tree::NodeRef;
use regex::Regex;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Section {
    pub heading: String,
    pub level: u8,
    pub text: String,
}

const DROP_SELECTORS: &str = concat!(
    "script,style,noscript,link,meta,iframe,object,embed,svg,math,",
    "figure,img,audio,video,table,sup.reference,sup.noprint,",
    ".infobox,.navbox,.vertical-navbox,.navbox-styles,.sidebar,.metadata,.ambox,",
    ".hatnote,.dablink,.rellink,.noprint,.mw-editsection,.mw-empty-elt,",
    ".reflist,.references,ol.references,.mw-references-wrap,.refbegin,.mw-cite-backlink,",
    ".gallery,.toc,#toc,.thumb,.sistersitebox,.portal,.portalbox,.catlinks,",
    ".mwe-math-element,.coordinates,#coordinates,footer,.mw-footer"
);

static DROP: LazyLock<Selector> = LazyLock::new(|| Selector::parse(DROP_SELECTORS).expect("drop selectors"));
static WALK: LazyLock<Selector> = LazyLock::new(|| Selector::parse("h1,h2,h3,h4,h5,h6,p,li,dd,dt,blockquote,pre").expect("walk selectors"));
static BODY: LazyLock<Selector> = LazyLock::new(|| Selector::parse("body").expect("body selector"));
static DROP_HEADINGS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        "(?i)^(δείτε επίσης|δειτε επισης|παραπομπές|παραπομπες|σημειώσεις|σημειωσεις|εξωτερικοί σύνδεσμοι|",
        "εξωτερικοι συνδεσμοι|βιβλιογραφία|βιβλιογραφια|πηγές|πηγες|περαιτέρω ανάγνωση|",
        "see also|references|notes|external links|further reading|bibliography|sources|citations)$"
    ))
    .expect("drop headings")
});

const BLOCK_TAGS: &[&str] = &["p", "li", "dd", "dt", "blockquote", "pre"];

// jsoup 1.23.2 TagSet (HTML namespace): Block, PreserveWhitespace and TextBoundary options.
const JSOUP_BLOCK: &[&str] = &[
    "html",
    "head",
    "body",
    "frameset",
    "script",
    "noscript",
    "style",
    "meta",
    "link",
    "title",
    "frame",
    "noframes",
    "section",
    "nav",
    "aside",
    "hgroup",
    "header",
    "footer",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dialog",
    "search",
    "ul",
    "ol",
    "pre",
    "div",
    "blockquote",
    "hr",
    "address",
    "figure",
    "figcaption",
    "form",
    "fieldset",
    "dl",
    "dt",
    "dd",
    "li",
    "table",
    "caption",
    "thead",
    "tfoot",
    "tbody",
    "colgroup",
    "col",
    "tr",
    "th",
    "td",
    "details",
    "menu",
    "plaintext",
    "template",
    "article",
    "main",
    "center",
    "dir",
    "applet",
    "marquee",
    "listing",
    "math",
    "svg",
];
const JSOUP_PRESERVE_WS: &[&str] = &["pre", "plaintext", "title", "textarea", "script"];
const JSOUP_TEXT_BOUNDARY: &[&str] = &[
    "button", "input", "select", "textarea", "option", "output", "progress", "meter", "img", "picture", "audio", "video", "canvas",
    "object", "embed", "iframe",
];

fn name<'a>(el: &ElementRef<'a>) -> &'a str {
    el.value().name()
}

fn is_block(n: &str) -> bool {
    JSOUP_BLOCK.contains(&n)
}

/// `StringUtil.isActuallyWhitespace`.
fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r' | '\u{a0}')
}

fn last_is_space(s: &str) -> bool {
    s.ends_with(' ')
}

/// `StringUtil.appendNormalisedWhitespace`.
fn append_normalised(accum: &mut String, text: &str, strip_leading: bool) {
    let mut last_was_white = false;
    let mut reached_non_white = false;
    for c in text.chars() {
        if is_ws(c) {
            if (strip_leading && !reached_non_white) || last_was_white {
                continue;
            }
            accum.push(' ');
            last_was_white = true;
        } else if c != '\u{200b}' && c != '\u{ad}' {
            accum.push(c);
            last_was_white = false;
            reached_non_white = true;
        }
    }
}

fn preserve_whitespace(parent: Option<NodeRef<'_, Node>>) -> bool {
    // jsoup looks at the parent and five more levels up.
    let mut node = parent;
    for _ in 0..6 {
        let Some(n) = node else { return false };
        if let Some(e) = n.value().as_element()
            && JSOUP_PRESERVE_WS.contains(&e.name())
        {
            return true;
        }
        node = n.parent();
    }
    false
}

fn has_text(node: NodeRef<'_, Node>) -> bool {
    node.descendants().any(|d| matches!(d.value(), Node::Text(t) if !t.chars().all(is_ws)))
}

fn is_inline_element(node: Option<NodeRef<'_, Node>>) -> bool {
    node.and_then(|n| n.value().as_element().map(|e| !is_block(e.name()))).unwrap_or(false)
}

fn is_text(node: Option<NodeRef<'_, Node>>) -> bool {
    matches!(node.map(|n| n.value()), Some(Node::Text(_)))
}

/// One step of the traversal: entering a node (its text and leading separator) or leaving an element
/// (its trailing separator, after all its children).
enum Step<'a> {
    Enter(NodeRef<'a, Node>),
    Exit(NodeRef<'a, Node>),
}

/// jsoup's depth-first text traversal with an explicit stack: an article's nesting depth is the
/// archive's choice, so it must not set the depth of the native call stack.
fn walk(root: NodeRef<'_, Node>, accum: &mut String) {
    let mut stack = vec![Step::Enter(root)];
    while let Some(step) = stack.pop() {
        match step {
            Step::Enter(node) => match node.value() {
                Node::Text(t) => {
                    if preserve_whitespace(node.parent()) {
                        accum.push_str(t);
                    } else {
                        let strip = last_is_space(accum);
                        append_normalised(accum, t, strip);
                    }
                }
                Node::Element(e) => {
                    let n = e.name();
                    let leading = is_block(n) || n == "br" || (JSOUP_TEXT_BOUNDARY.contains(&n) && node.has_children() && has_text(node));
                    if !accum.is_empty() && leading && !last_is_space(accum) {
                        accum.push(' ');
                    }
                    stack.push(Step::Exit(node));
                    stack.extend(node.children().rev().map(Step::Enter));
                }
                _ => {}
            },
            Step::Exit(node) => {
                let Some(e) = node.value().as_element() else { continue };
                let n = e.name();
                let has_block_child = node.children().any(|c| c.value().as_element().is_some_and(|ce| is_block(ce.name())));
                let trailing = JSOUP_TEXT_BOUNDARY.contains(&n) || is_block(n) || has_block_child;
                let next = node.next_sibling();
                if trailing && (is_text(next) || is_inline_element(next)) && !last_is_space(accum) {
                    accum.push(' ');
                }
            }
        }
    }
}

/// jsoup `Element.text()`: normalised text of the element and its descendants, Java-trimmed.
pub fn jsoup_text(el: ElementRef<'_>) -> String {
    let mut accum = String::new();
    // The element itself is the traversal root: its own leading/trailing separators never apply
    // (accum is empty at its head; its tail sees siblings, which jsoup's traversal also visits).
    for child in el.children() {
        walk(child, &mut accum);
    }
    java_trim(&accum).to_owned()
}

/// Java `String.trim()`: strips chars <= U+0020 at both ends.
fn java_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c <= ' ')
}

/// Kotlin `replace(Regex("\\s+"), " ").trim()` as it runs on Android: the platform regex is ICU, whose
/// `\s` is Unicode whitespace (thin and narrow no-break spaces included), and Kotlin's `trim()` is
/// Unicode-aware too. (An ASCII-only collapse changed the spaces of 16 of 108 parity articles.)
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out.trim_matches(char::is_whitespace).to_owned()
}

fn has_block_ancestor(el: &ElementRef<'_>) -> bool {
    let mut parent = el.parent();
    while let Some(p) = parent {
        if let Some(e) = p.value().as_element()
            && BLOCK_TAGS.contains(&e.name())
        {
            return true;
        }
        parent = p.parent();
    }
    false
}

/// Kotlin `String.isNotBlank()`.
fn is_not_blank(s: &str) -> bool {
    s.chars().any(|c| !c.is_whitespace())
}

pub fn extract_sections(html: &str, title: &str) -> Vec<Section> {
    let mut doc = Html::parse_document(html);
    let drop: Vec<_> = doc.select(&DROP).map(|e| e.id()).collect();
    for id in drop {
        if let Some(mut node) = doc.tree.get_mut(id) {
            node.detach();
        }
    }
    let Some(body) = doc.select(&BODY).next() else { return Vec::new() };

    let mut sections = Vec::new();
    let mut heading = String::new();
    let mut level: u8 = 1;
    let mut dropping = false;
    let mut drop_level: u8 = 0;
    let mut buffer = String::new();

    let flush = |buffer: &mut String, sections: &mut Vec<Section>, heading: &str, level: u8, dropping: bool| {
        let text = buffer.split('\n').map(collapse_ws).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
        if !text.is_empty() && !dropping {
            sections.push(Section { heading: heading.to_owned(), level, text });
        }
        buffer.clear();
    };

    for el in body.select(&WALK) {
        let tag = name(&el);
        if let Some(digit) = tag.strip_prefix('h').and_then(|d| d.parse::<u8>().ok()) {
            flush(&mut buffer, &mut sections, &heading, level, dropping);
            let heading_text = collapse_ws(&jsoup_text(el));
            if digit == 1 && heading_text == title {
                continue;
            }
            if dropping && digit > drop_level {
                continue;
            }
            dropping = DROP_HEADINGS.is_match(&heading_text);
            drop_level = digit;
            heading = heading_text;
            level = digit;
            continue;
        }
        if dropping || has_block_ancestor(&el) {
            continue;
        }
        let text = jsoup_text(el);
        if is_not_blank(&text) {
            buffer.push_str(&text);
            buffer.push('\n');
        }
    }
    flush(&mut buffer, &mut sections, &heading, level, dropping);
    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deeply_nested_markup_is_walked_without_recursion() {
        // Deep enough to overflow a 2 MiB thread stack with one frame per element (the parser itself is
        // quadratic in the depth, as in browsers without a depth cap, so not deeper).
        let depth = 10_000;
        let html = format!("<html><body>{}<p>bottom</p>{}<p>after</p></body></html>", "<div>".repeat(depth), "</div>".repeat(depth));
        let doc = Html::parse_document(&html);
        let body = doc.select(&scraper::Selector::parse("body").expect("selector")).next().expect("body");
        assert_eq!(jsoup_text(body), "bottom after");
        let sections = extract_sections(&html, "Deep");
        assert!(sections.iter().any(|s| s.text.contains("bottom")), "{sections:?}");
    }

    fn text_of(html: &str) -> String {
        let doc = Html::parse_fragment(html);
        let root = doc.root_element();
        jsoup_text(root)
    }

    #[test]
    fn jsoup_separators_at_blocks_and_br() {
        assert_eq!(text_of("<p>O<br>3</p>"), "O 3");
        assert_eq!(text_of("<div>a</div><div>b</div>"), "a b");
        assert_eq!(text_of("<p>a <b>bold</b>text</p>"), "a boldtext");
        assert_eq!(text_of("<p>x\u{a0}\u{a0}y\u{200b}z</p>"), "x yz");
        assert_eq!(text_of("<span>a</span><span>b</span>"), "ab");
    }

    #[test]
    fn unicode_spaces_collapse_like_android() {
        // Thin space, narrow no-break space and ideographic space become one ASCII space (ICU \s).
        let html = "<html><body><p>3\u{2009}760 km\u{202f}2 \u{3000} total</p></body></html>";
        assert_eq!(extract_sections(html, "T")[0].text, "3 760 km 2 total");
    }

    #[test]
    fn pre_keeps_its_whitespace() {
        assert_eq!(text_of("<pre>a\n  b</pre>"), "a\n  b");
    }

    #[test]
    fn sections_drop_boilerplate_and_reference_sections() {
        let html = r#"<html><head><title>T</title></head><body>
          <h1>Water</h1>
          <table class="infobox"><tr><td>infobox</td></tr></table>
          <p>Water is H<sub>2</sub>O.<sup class="reference">[1]</sup></p>
          <h2>Uses</h2><p>Drinking.</p><ul><li>Cooking</li><li>Washing <p>nested</p></li></ul>
          <h2>See also</h2><p>Ice</p><h3>More</h3><p>Steam</p>
          <h2>Notes</h2><p>n</p>
          <h2>Safety</h2><p>Boil it.</p>
        </body></html>"#;
        let s = extract_sections(html, "Water");
        assert_eq!(
            s,
            vec![
                Section { heading: String::new(), level: 1, text: "Water is H2O.".into() },
                Section { heading: "Uses".into(), level: 2, text: "Drinking.\nCooking\nWashing nested".into() },
                Section { heading: "Safety".into(), level: 2, text: "Boil it.".into() },
            ]
        );
    }
}
