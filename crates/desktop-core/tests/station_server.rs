//! Station mode over real TLS, with a client that behaves like `TransferClient.kt` (TLS 1.3, trusts
//! exactly the pinned certificate SHA-256, Bearer token): the protocol, the sealing (only selected
//! packs, never user data, GET only), Range reads, many concurrent phones, TLS 1.2 refused, idle stop.

use desktop_core::catalog::sha256_hex;
use desktop_core::station::cert::SessionCert;
use desktop_core::station::server::{ServerConfig, StationServer};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

#[derive(Debug)]
struct Pin(String);

impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if sha256_hex(end.as_ref()) == self.0 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate does not match the pairing code".into()))
        }
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

fn connector(pin: &str, tls12_only: bool) -> TlsConnector {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let versions: &[&'static rustls::SupportedProtocolVersion] =
        if tls12_only { &[&rustls::version::TLS12] } else { &[&rustls::version::TLS13] };
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .expect("versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin(pin.into())))
        .with_no_client_auth();
    TlsConnector::from(Arc::new(cfg))
}

struct Resp {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn request(addr: SocketAddr, pin: &str, method: &str, path: &str, token: Option<&str>, range: Option<&str>) -> std::io::Result<Resp> {
    let tcp = TcpStream::connect(addr).await?;
    let mut tls = connector(pin, false).connect(ServerName::try_from("127.0.0.1").expect("name"), tcp).await?;
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: SKEPI\r\n");
    if let Some(t) = token {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(r) = range {
        head.push_str(&format!("Range: {r}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    tls.write_all(head.as_bytes()).await?;
    let mut raw = Vec::new();
    let _ = tls.read_to_end(&mut raw).await;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("head");
    let text = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = text.split("\r\n");
    let status = lines.next().and_then(|l| l.split(' ').nth(1)).and_then(|s| s.parse().ok()).expect("status");
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
    Ok(Resp { status, headers, body: raw[split + 4..].to_vec() })
}

async fn start(idle: Duration) -> (StationServer, SocketAddr, String, Vec<u8>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tmp");
    let pack: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(dir.path().join("sel.zim"), &pack).expect("pack");
    std::fs::write(dir.path().join("app.db"), b"user data").expect("db");
    std::fs::write(dir.path().join("other.zim"), b"not selected").expect("other");
    let cert = SessionCert::create().expect("cert");
    let mut packs = HashMap::new();
    packs.insert("sel-pack".to_string(), dir.path().join("sel.zim"));
    let cfg = ServerConfig {
        token: TOKEN.into(),
        manifest: br#"{"v":1,"catalog":null,"packs":[]}"#.to_vec(),
        packs,
        idle_timeout: idle,
        max_connections: 32,
    };
    let server = StationServer::start("127.0.0.1:0".parse().expect("addr"), &cert, cfg).await.expect("start");
    let addr: SocketAddr = format!("127.0.0.1:{}", server.port()).parse().expect("addr");
    (server, addr, cert.sha256, pack, dir)
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_manifest_and_ranges_over_pinned_tls13() {
    let (server, addr, pin, pack, _dir) = start(Duration::from_secs(60)).await;
    let m = request(addr, &pin, "GET", "/manifest", Some(TOKEN), None).await.expect("manifest");
    assert_eq!(m.status, 200);
    assert_eq!(m.body, br#"{"v":1,"catalog":null,"packs":[]}"#);
    let r = request(addr, &pin, "GET", "/pack/sel-pack", Some(TOKEN), Some("bytes=65536-131071")).await.expect("range");
    assert_eq!(r.status, 206);
    assert_eq!(r.headers.get("content-range").map(String::as_str), Some("bytes 65536-131071/300000"));
    assert_eq!(r.body, pack[65536..131072]);
    let last = request(addr, &pin, "GET", "/pack/sel-pack", Some(TOKEN), Some("bytes=262144-")).await.expect("tail");
    assert_eq!(last.body, pack[262144..]);
    let bad = request(addr, &pin, "GET", "/pack/sel-pack", Some(TOKEN), Some("bytes=400000-")).await.expect("416");
    assert_eq!(bad.status, 416);
    assert!(server.status().bytes_served >= 65536);
}

#[tokio::test(flavor = "multi_thread")]
async fn token_methods_and_unselected_paths_are_refused() {
    let (_server, addr, pin, _pack, _dir) = start(Duration::from_secs(60)).await;
    assert_eq!(request(addr, &pin, "GET", "/manifest", None, None).await.expect("r").status, 401);
    assert_eq!(request(addr, &pin, "GET", "/manifest", Some("ffffffffffffffffffffffffffffffff"), None).await.expect("r").status, 401);
    assert_eq!(request(addr, &pin, "POST", "/manifest", Some(TOKEN), None).await.expect("r").status, 405);
    assert_eq!(request(addr, &pin, "PUT", "/pack/sel-pack", Some(TOKEN), None).await.expect("r").status, 405);
    for path in [
        "/pack/other",
        "/pack/other.zim",
        "/pack/../app.db",
        "/pack/sel-pack/../other",
        "/pack/%2e%2e/app.db",
        "/pack/%252e%252e%252fapp.db",
        "/pack/..%5capp.db",
        "/pack/SEL-PACK",
        "/app.db",
        "/settings",
        "/notes",
        "/conversations",
        "/",
        "/pack/",
        "/manifest/../app.db",
        "/sel.zim",
    ] {
        let r = request(addr, &pin, "GET", path, Some(TOKEN), None).await.expect("r");
        assert_eq!(r.status, 404, "{path}");
        assert!(!r.body.windows(9).any(|w| w == b"user data"), "{path}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn other_certificates_and_tls12_are_refused() {
    let (_server, addr, _pin, _pack, _dir) = start(Duration::from_secs(60)).await;
    assert!(request(addr, &"0".repeat(64), "GET", "/manifest", Some(TOKEN), None).await.is_err(), "pin mismatch must fail the handshake");
    let tcp = TcpStream::connect(addr).await.expect("tcp");
    let pin = _pin.clone();
    assert!(connector(&pin, true).connect(ServerName::try_from("127.0.0.1").expect("name"), tcp).await.is_err(), "TLS 1.2 must be refused");
}

#[tokio::test(flavor = "multi_thread")]
async fn many_phones_at_once() {
    let (server, addr, pin, pack, _dir) = start(Duration::from_secs(60)).await;
    let mut tasks = Vec::new();
    for i in 0..16u64 {
        let pin = pin.clone();
        tasks.push(tokio::spawn(async move {
            let start = (i % 4) * 65536;
            request(addr, &pin, "GET", "/pack/sel-pack", Some(TOKEN), Some(&format!("bytes={start}-{}", start + 65535)))
                .await
                .map(|r| (start, r))
        }));
    }
    for t in tasks {
        let (start, r) = t.await.expect("join").expect("request");
        assert_eq!(r.status, 206);
        assert_eq!(r.body, pack[start as usize..start as usize + 65536]);
    }
    assert_eq!(server.status().requests, 16);
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_after_the_idle_timeout() {
    let (server, addr, pin, _pack, _dir) = start(Duration::from_millis(1500)).await;
    assert_eq!(request(addr, &pin, "GET", "/manifest", Some(TOKEN), None).await.expect("r").status, 200);
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!server.is_running());
    assert_eq!(server.status().stop_reason.as_deref(), Some("idle"));
    assert!(request(addr, &pin, "GET", "/manifest", Some(TOKEN), None).await.is_err());
}

#[test]
fn session_certificates_are_fresh() {
    let a = SessionCert::create().expect("a");
    let b = SessionCert::create().expect("b");
    assert_ne!(a.sha256, b.sha256);
    assert_eq!(a.sha256, sha256_hex(&a.cert_der));
    assert_eq!(a.sha256.len(), 64);
}

/// Opens `n` TCP connections from `from` that never start TLS (a peer without the token holding sockets).
async fn idle_sockets(from: &str, to: SocketAddr, n: usize) -> Option<Vec<TcpStream>> {
    let mut out = Vec::new();
    for _ in 0..n {
        let socket = tokio::net::TcpSocket::new_v4().ok()?;
        // Another loopback address stands for another device (macOS has only 127.0.0.1 by default).
        socket.bind(format!("{from}:0").parse().ok()?).ok()?;
        out.push(socket.connect(to).await.ok()?);
    }
    Some(out)
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_unauthenticated_sockets_do_not_lock_out_phones() {
    let (_server, addr, pin, _pack, _dir) = start(Duration::from_secs(60)).await;
    // More idle sockets than the phones' 32 connection slots.
    let Some(mut idle) = idle_sockets("127.0.0.2", addr, 64).await else {
        eprintln!("skipped: cannot bind 127.0.0.2 on this host");
        return;
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = tokio::time::timeout(Duration::from_secs(10), request(addr, &pin, "GET", "/manifest", Some(TOKEN), None))
        .await
        .expect("served while the idle sockets are open")
        .expect("request");
    assert_eq!(r.status, 200);
    // Idle sockets are closed after the short pre-auth deadline, not after the 30 s transfer timeout.
    let mut buf = [0u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(8), idle[0].read(&mut buf)).await;
    assert!(matches!(closed, Ok(Ok(0)) | Ok(Err(_))), "closed within the pre-auth deadline: {closed:?}");
}
