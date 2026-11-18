//! The `test-mirror` feature embeds the local test mirror CA (`include_bytes!` in `src/download.rs`).
//! The certificates are generated on demand and never committed, so a missing CA gets a clear message
//! here instead of an `include_bytes!` error.

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_TEST_MIRROR").is_none() {
        return;
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let ca = Path::new(&manifest_dir).join("../../e2e/mirror/certs/ca.crt");
    println!("cargo:rerun-if-changed={}", ca.display());
    assert!(
        ca.is_file(),
        "the test-mirror feature embeds e2e/mirror/certs/ca.crt, which is missing: run `node e2e/mirror/gen-certs.mjs` \
         first (the test mirror certificates are generated on demand, see e2e/mirror/certs/README.md)"
    );
}
