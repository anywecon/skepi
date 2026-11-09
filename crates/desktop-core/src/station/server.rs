//! Station mode's read-only HTTPS server: exactly the protocol of `TransferServer.kt` (TLS 1.3 only,
//! per-session certificate, `Authorization: Bearer <token>` compared in constant time,
//! `GET /manifest` and `GET /pack/<id>` with Range), but for many phones at once. Only the files in
//! `packs` (the packs the user selected, mapped by the native side from app.db) can ever be served:
//! no URL reaches the filesystem. Stops on demand or after `idle_timeout` without a request.

use super::cert::SessionCert;
use super::http::{plain, read_request, write_head};
use crate::range::parse_range;
use regex::Regex;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, Semaphore};
use tokio_rustls::TlsAcceptor;

static PACK_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/pack/([a-z0-9][a-z0-9._-]{1,79})$").expect("regex"));
const SOCKET_TIMEOUT: Duration = Duration::from_secs(30);

/// Unauthenticated connections have a budget of their own and a short deadline: per peer address at
/// most `PREAUTH_PER_PEER` TLS handshakes at once (more wait, up to the deadline) and
/// `PENDING_PER_PEER` open sockets, `PENDING_MAX` in total. A phone's connection takes a slot of
/// `max_connections` only after its token was checked, so peers without the token (anyone on the
/// network) cannot hold the phones' slots, and one address cannot hold everyone's pre-auth budget.
const PREAUTH_TIMEOUT: Duration = Duration::from_secs(5);
const PREAUTH_PER_PEER: usize = 4;
const PENDING_PER_PEER: usize = 32;
const PENDING_MAX: usize = 256;

#[derive(Default)]
struct PreAuth {
    peers: Mutex<HashMap<IpAddr, (usize, Arc<Semaphore>)>>,
    total: AtomicUsize,
}

/// One unauthenticated socket's place in the budget (released when dropped) and its address's
/// handshake slots.
struct PreAuthTicket {
    ip: IpAddr,
    budget: Arc<PreAuth>,
    handshakes: Arc<Semaphore>,
}

impl PreAuth {
    fn admit(self: &Arc<Self>, ip: IpAddr) -> Option<PreAuthTicket> {
        let mut peers = self.peers.lock().unwrap_or_else(|p| p.into_inner());
        if self.total.load(Ordering::SeqCst) >= PENDING_MAX {
            return None;
        }
        let (pending, handshakes) = peers.entry(ip).or_insert_with(|| (0, Arc::new(Semaphore::new(PREAUTH_PER_PEER))));
        if *pending >= PENDING_PER_PEER {
            return None;
        }
        *pending += 1;
        let handshakes = handshakes.clone();
        self.total.fetch_add(1, Ordering::SeqCst);
        Some(PreAuthTicket { ip, budget: self.clone(), handshakes })
    }
}

impl Drop for PreAuthTicket {
    fn drop(&mut self) {
        let mut peers = self.budget.peers.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = peers.get_mut(&self.ip) {
            entry.0 -= 1;
            if entry.0 == 0 {
                peers.remove(&self.ip);
            }
        }
        self.budget.total.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct ServerConfig {
    pub token: String,
    pub manifest: Vec<u8>,
    pub packs: HashMap<String, PathBuf>,
    pub idle_timeout: Duration,
    /// Concurrent connections (several phones, each one connection per chunk).
    pub max_connections: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub peer: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub requests: u64,
    pub bytes_served: u64,
    pub active_connections: u64,
    pub last_activity_at_ms: i64,
    pub stop_reason: Option<String>,
    pub peers: Vec<String>,
    pub log: Vec<LogEntry>,
}

struct Shared {
    cfg: ServerConfig,
    running: AtomicBool,
    requests: AtomicU64,
    bytes: AtomicU64,
    active: AtomicU64,
    last_activity: AtomicI64,
    stop_reason: Mutex<Option<String>>,
    log: Mutex<VecDeque<LogEntry>>,
    shutdown: Notify,
}

fn now_ms() -> i64 {
    crate::content::now_ms()
}

impl Shared {
    fn record(&self, method: &str, path: &str, status: u16, peer: &SocketAddr) {
        let mut log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        if log.len() >= 500 {
            log.pop_front();
        }
        log.push_back(LogEntry {
            method: method.into(),
            path: path.chars().take(120).collect(),
            status,
            peer: peer.ip().to_string(),
            at_ms: now_ms(),
        });
    }

    fn stop(&self, reason: &str) {
        if self.running.swap(false, Ordering::SeqCst) {
            *self.stop_reason.lock().unwrap_or_else(|p| p.into_inner()) = Some(reason.into());
            self.shutdown.notify_waiters();
        }
    }

    fn authorized(&self, header: Option<&String>) -> bool {
        let Some(given) = header.and_then(|h| h.strip_prefix("Bearer ")).map(str::trim) else { return false };
        given.as_bytes().ct_eq(self.cfg.token.as_bytes()).into()
    }
}

pub struct StationServer {
    shared: Arc<Shared>,
    port: u16,
}

impl StationServer {
    pub async fn start(bind: SocketAddr, cert: &SessionCert, cfg: ServerConfig) -> std::io::Result<Self> {
        crate::install_crypto_provider();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(std::io::Error::other)?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert.cert_der.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.key_der.clone())),
            )
            .map_err(std::io::Error::other)?;
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind(bind).await?;
        let port = listener.local_addr()?.port();
        let permits = Arc::new(Semaphore::new(cfg.max_connections.max(1)));
        let preauth = Arc::new(PreAuth::default());
        let idle = cfg.idle_timeout;
        let shared = Arc::new(Shared {
            cfg,
            running: AtomicBool::new(true),
            requests: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            active: AtomicU64::new(0),
            last_activity: AtomicI64::new(now_ms()),
            stop_reason: Mutex::new(None),
            log: Mutex::new(VecDeque::new()),
            shutdown: Notify::new(),
        });

        let s = shared.clone();
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    a = listener.accept() => a,
                    () = s.shutdown.notified() => break,
                };
                if !s.running.load(Ordering::SeqCst) {
                    break;
                }
                let Ok((tcp, peer)) = accepted else { continue };
                // Over the pre-auth budget (in total or for this address): refuse (the phone retries the chunk).
                let Some(ticket) = preauth.admit(peer.ip()) else { continue };
                let s2 = s.clone();
                let acceptor = acceptor.clone();
                let permits = permits.clone();
                tokio::spawn(async move {
                    let _ = serve(&s2, acceptor, tcp, peer, ticket, permits).await;
                });
            }
        });

        let s = shared.clone();
        tokio::spawn(async move {
            while s.running.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(1)).await;
                // A transfer in progress counts as activity (bytes update last_activity).
                if now_ms() - s.last_activity.load(Ordering::SeqCst) > idle.as_millis() as i64 && s.active.load(Ordering::SeqCst) == 0 {
                    s.stop("idle");
                }
            }
        });
        Ok(Self { shared, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(&self, reason: &str) {
        self.shared.stop(reason);
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> ServerStatus {
        let log: Vec<LogEntry> = self.shared.log.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect();
        let mut peers: Vec<String> = log.iter().map(|l| l.peer.clone()).collect();
        peers.sort();
        peers.dedup();
        ServerStatus {
            running: self.is_running(),
            port: self.port,
            requests: self.shared.requests.load(Ordering::SeqCst),
            bytes_served: self.shared.bytes.load(Ordering::SeqCst),
            active_connections: self.shared.active.load(Ordering::SeqCst),
            last_activity_at_ms: self.shared.last_activity.load(Ordering::SeqCst),
            stop_reason: self.shared.stop_reason.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            peers,
            log: log.into_iter().rev().take(50).collect(),
        }
    }
}

async fn serve(
    s: &Shared,
    acceptor: TlsAcceptor,
    tcp: TcpStream,
    peer: SocketAddr,
    ticket: PreAuthTicket,
    permits: Arc<Semaphore>,
) -> std::io::Result<()> {
    // At most PREAUTH_PER_PEER handshakes per address at once; the others wait up to the deadline.
    let handshake = tokio::time::timeout(PREAUTH_TIMEOUT, ticket.handshakes.clone().acquire_owned())
        .await
        .map_err(|_| std::io::Error::other("busy"))?
        .map_err(std::io::Error::other)?;
    // Handshake and request head share one short deadline, inside the pre-auth budget.
    let head = tokio::time::timeout(PREAUTH_TIMEOUT, async {
        let mut tls = acceptor.accept(tcp).await?;
        let req = read_request(&mut tls).await?;
        Ok::<_, std::io::Error>((tls, req))
    })
    .await
    .map_err(|_| std::io::Error::other("handshake or request timeout"))?;
    drop(handshake);
    drop(ticket);
    let (mut tls, req) = head?;
    if !s.authorized(req.headers.get("authorization")) {
        let status = plain(&mut tls, 401, "Unauthorized").await?;
        s.record(&req.method, &req.path, status, &peer);
        tls.shutdown().await.ok();
        return Ok(());
    }
    // Only now a slot for phones; all taken: refuse (the phone retries the chunk).
    let Ok(permit) = permits.try_acquire_owned() else {
        let status = plain(&mut tls, 503, "Busy").await?;
        s.record(&req.method, &req.path, status, &peer);
        tls.shutdown().await.ok();
        return Ok(());
    };
    s.active.fetch_add(1, Ordering::SeqCst);
    s.last_activity.store(now_ms(), Ordering::SeqCst);
    s.requests.fetch_add(1, Ordering::SeqCst);
    let served = async {
        let status = route(s, &req, &mut tls).await?;
        s.record(&req.method, &req.path, status, &peer);
        tls.flush().await?;
        tls.shutdown().await.ok();
        Ok::<_, std::io::Error>(())
    }
    .await;
    s.active.fetch_sub(1, Ordering::SeqCst);
    drop(permit);
    served
}

async fn route<W: tokio::io::AsyncWrite + Unpin>(s: &Shared, req: &super::http::Request, out: &mut W) -> std::io::Result<u16> {
    if !s.authorized(req.headers.get("authorization")) {
        return plain(out, 401, "Unauthorized").await;
    }
    if req.method != "GET" {
        return plain(out, 405, "Method Not Allowed").await;
    }
    if req.path == "/manifest" {
        let m = &s.cfg.manifest;
        write_head(
            out,
            200,
            "OK",
            &[("Content-Type", "application/json".into()), ("Content-Length", m.len().to_string()), ("Cache-Control", "no-store".into())],
        )
        .await?;
        out.write_all(m).await?;
        s.bytes.fetch_add(m.len() as u64, Ordering::SeqCst);
        return Ok(200);
    }
    let Some(caps) = PACK_PATH.captures(&req.path) else { return plain(out, 404, "Not Found").await };
    let Some(file) = s.cfg.packs.get(&caps[1]) else { return plain(out, 404, "Not Found").await };
    let mut f = match tokio::fs::File::open(file).await {
        Ok(f) => f,
        Err(_) => return plain(out, 404, "Not Found").await,
    };
    let size = f.metadata().await?.len();
    let range = match parse_range(req.headers.get("range").map(String::as_str), size) {
        Ok(r) => r,
        Err(_) => {
            write_head(out, 416, "Range Not Satisfiable", &[("Content-Range", format!("bytes */{size}")), ("Content-Length", "0".into())])
                .await?;
            return Ok(416);
        }
    };
    let (start, end) = range.unwrap_or((0, size.saturating_sub(1)));
    let length = if size == 0 { 0 } else { end - start + 1 };
    let mut headers = vec![
        ("Content-Type", "application/octet-stream".to_string()),
        ("Content-Length", length.to_string()),
        ("Accept-Ranges", "bytes".to_string()),
    ];
    if range.is_some() {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{size}")));
    }
    let status = if range.is_some() { 206 } else { 200 };
    write_head(out, status, if range.is_some() { "Partial Content" } else { "OK" }, &headers).await?;
    f.seek(std::io::SeekFrom::Start(start)).await?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut left = length;
    while left > 0 {
        let want = (buf.len() as u64).min(left) as usize;
        let n = f.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        tokio::time::timeout(SOCKET_TIMEOUT, out.write_all(&buf[..n])).await.map_err(|_| std::io::Error::other("write timeout"))??;
        left -= n as u64;
        s.bytes.fetch_add(n as u64, Ordering::SeqCst);
        s.last_activity.store(now_ms(), Ordering::SeqCst);
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthenticated_sockets_have_their_own_budget_per_peer_and_in_total() {
        let budget = Arc::new(PreAuth::default());
        let attacker: IpAddr = "192.168.1.66".parse().expect("ip");
        let held: Vec<_> = (0..100).filter_map(|_| budget.admit(attacker)).collect();
        assert_eq!(held.len(), PENDING_PER_PEER, "one address holds at most its share");
        assert_eq!(held[0].handshakes.available_permits(), PREAUTH_PER_PEER, "and handshakes one address's slots at a time");
        let phone: IpAddr = "192.168.1.20".parse().expect("ip");
        assert!(budget.admit(phone).is_some(), "another address still gets in");
        let mut others = Vec::new();
        for i in 0..=255u8 {
            for j in 0..2u8 {
                if let Some(t) = budget.admit(IpAddr::from([10, 0, j, i])) {
                    others.push(t);
                }
            }
        }
        assert_eq!(held.len() + others.len(), PENDING_MAX, "the total is bounded");
        drop(held);
        drop(others);
        assert!(budget.peers.lock().expect("lock").is_empty(), "released when the sockets close");
        assert!(budget.admit(attacker).is_some());
    }
}
