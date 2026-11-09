//! Station mode (architecture: "P2P content sharing", Desktop as "Station"): the desktop serves the
//! packs the user selected to many phones on the LAN, speaking exactly the protocol of
//! modules/expo-transfer. The UI builds the manifest with `@skepi/core` `buildManifest`; this side
//! checks it against app.db and the accepted catalog and maps pack ids to files itself, so the
//! webview can never make the server expose another file or any user data.

pub mod apk;
pub mod cert;
pub mod http;
pub mod server;

use crate::catalog::{PackKind, to_base64};
use crate::content::ContentStore;
use crate::db::PackRow;
use serde::Serialize;
use serde_json::Value;
use server::{ServerConfig, ServerStatus, StationServer};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const MAX_CONNECTIONS: usize = 32;
const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum StationError {
    #[error("ERR_STATION_RUNNING: Station mode is already running")]
    Running,
    #[error("ERR_STATION_HOST: {0}")]
    Host(String),
    #[error("ERR_STATION_PACK: {0}")]
    Pack(String),
    #[error("ERR_STATION_MANIFEST: {0}")]
    Manifest(String),
    #[error("ERR_STATION_APK: {0}")]
    Apk(String),
    #[error("ERR_STATION: {0}")]
    Io(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAddress {
    pub ip: String,
    pub adapter: String,
    /// Hyper-V, WSL, VirtualBox, VMware…: listed last, rarely what phones can reach.
    pub virtual_adapter: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationInfo {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub cert_sha256: String,
    pub apk_url: Option<String>,
    pub apk_cert_sha256: Option<String>,
    pub apk_official: Option<bool>,
    pub packs: Vec<String>,
}

#[derive(Default)]
pub struct Station {
    server: Mutex<Option<StationServer>>,
    apk: Mutex<Option<apk::ApkServer>>,
    info: Mutex<Option<StationInfo>>,
}

pub fn is_local(ip: &Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// The pack rows the server may serve: selected, installed, inside the content folder, and either
/// verified or an unverified ZIM (no receiver can accept anything else).
fn shareable(store: &ContentStore, ids: &[String]) -> Result<Vec<PackRow>, StationError> {
    let root = store.root();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let row = store
            .db
            .get_pack(id)
            .map_err(|e| StationError::Pack(e.to_string()))?
            .ok_or_else(|| StationError::Pack(format!("{id} is not installed")))?;
        if !row.verified && row.kind != PackKind::Zim {
            return Err(StationError::Pack(format!("{id}: unverified models, maps and places are never shared")));
        }
        let path = PathBuf::from(&row.path);
        if !path.starts_with(&root) || !path.is_file() {
            return Err(StationError::Pack(format!("{id}: file missing from the content folder")));
        }
        out.push(row);
    }
    if out.is_empty() {
        return Err(StationError::Pack("select at least one pack".into()));
    }
    Ok(out)
}

/// The manifest must list exactly the selected packs with their installed hash, size, kind and
/// version, and carry either no catalog or exactly the catalog this desktop accepted.
pub fn check_manifest(manifest: &str, rows: &[PackRow], catalog: Option<(Vec<u8>, String)>) -> Result<(), StationError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(StationError::Manifest("too large".into()));
    }
    let v: Value = serde_json::from_str(manifest).map_err(|e| StationError::Manifest(e.to_string()))?;
    if v.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(StationError::Manifest("unsupported version".into()));
    }
    let packs = v.get("packs").and_then(Value::as_array).ok_or_else(|| StationError::Manifest("no pack list".into()))?;
    if packs.len() != rows.len() {
        return Err(StationError::Manifest("the manifest must list exactly the selected packs".into()));
    }
    let by_id: HashMap<&str, &PackRow> = rows.iter().map(|r| (r.id.as_str(), r)).collect();
    for p in packs {
        let id = p.get("id").and_then(Value::as_str).unwrap_or("");
        let row = by_id.get(id).ok_or_else(|| StationError::Manifest(format!("{id} was not selected")))?;
        let same = p.get("sha256").and_then(Value::as_str) == Some(row.sha256.as_str())
            && p.get("sizeBytes").and_then(Value::as_u64) == Some(row.size_bytes)
            && p.get("kind").and_then(Value::as_str) == Some(row.kind.as_str())
            && p.get("version").and_then(Value::as_str) == Some(row.version.as_str());
        if !same {
            return Err(StationError::Manifest(format!("{id} does not match the installed pack")));
        }
    }
    match (v.get("catalog"), catalog) {
        (None | Some(Value::Null), _) => {}
        (Some(c), Some((bytes, sig))) => {
            if c.get("bytes").and_then(Value::as_str) != Some(to_base64(&bytes).as_str())
                || c.get("signature").and_then(Value::as_str) != Some(sig.as_str())
            {
                return Err(StationError::Manifest("catalog differs from the accepted one".into()));
            }
        }
        (Some(_), None) => return Err(StationError::Manifest("no accepted catalog to propagate".into())),
    }
    Ok(())
}

impl Station {
    pub fn is_running(&self) -> bool {
        self.server.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(StationServer::is_running)
    }

    pub async fn start(
        &self,
        store: &ContentStore,
        host: &str,
        pack_ids: &[String],
        manifest: &str,
        apk_path: Option<PathBuf>,
        idle: Duration,
    ) -> Result<StationInfo, StationError> {
        if self.is_running() {
            return Err(StationError::Running);
        }
        let ip: Ipv4Addr = host.parse().map_err(|_| StationError::Host("not an IPv4 address".into()))?;
        if !is_local(&ip) || !local_addresses().iter().any(|a| a.ip == host) {
            return Err(StationError::Host(format!("{host} is not a local network address of this computer")));
        }
        let rows = shareable(store, pack_ids)?;
        check_manifest(manifest, &rows, store.catalog_document())?;
        let mut token = [0u8; 16];
        getrandom::fill(&mut token).map_err(|e| StationError::Io(e.to_string()))?;
        let token = crate::catalog::hex(&token);
        let cert = cert::SessionCert::create().map_err(StationError::Io)?;
        let packs: HashMap<String, PathBuf> = rows.iter().map(|r| (r.id.clone(), PathBuf::from(&r.path))).collect();
        let cfg = ServerConfig {
            token: token.clone(),
            manifest: manifest.as_bytes().to_vec(),
            packs,
            idle_timeout: idle,
            max_connections: MAX_CONNECTIONS,
        };
        let server =
            StationServer::start(SocketAddr::new(IpAddr::V4(ip), 0), &cert, cfg).await.map_err(|e| StationError::Io(e.to_string()))?;
        let mut info = StationInfo {
            host: host.into(),
            port: server.port(),
            token,
            cert_sha256: cert.sha256.clone(),
            apk_url: None,
            apk_cert_sha256: None,
            apk_official: None,
            packs: rows.iter().map(|r| r.id.clone()).collect(),
        };
        if let Some(apk_path) = apk_path {
            match apk::ApkServer::start(SocketAddr::new(IpAddr::V4(ip), 0), apk_path).await {
                Ok(a) => {
                    info.apk_url = Some(format!("http://{host}:{}/", a.port()));
                    info.apk_cert_sha256 = Some(a.signing_sha256.clone());
                    info.apk_official = Some(a.official);
                    *self.apk.lock().unwrap_or_else(|p| p.into_inner()) = Some(a);
                }
                Err(e) => {
                    server.stop("apk");
                    return Err(StationError::Apk(e));
                }
            }
        }
        *self.server.lock().unwrap_or_else(|p| p.into_inner()) = Some(server);
        *self.info.lock().unwrap_or_else(|p| p.into_inner()) = Some(info.clone());
        Ok(info)
    }

    pub fn stop(&self, reason: &str) {
        if let Some(s) = self.server.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            s.stop(reason);
        }
        if let Some(a) = self.apk.lock().unwrap_or_else(|p| p.into_inner()).take() {
            a.stop();
        }
    }

    pub fn status(&self) -> Option<(StationInfo, ServerStatus)> {
        let info = self.info.lock().unwrap_or_else(|p| p.into_inner()).clone()?;
        let server = self.server.lock().unwrap_or_else(|p| p.into_inner());
        let status = server.as_ref()?.status();
        if !status.running
            && let Some(a) = self.apk.lock().unwrap_or_else(|p| p.into_inner()).take()
        {
            // Idle stop ends the APK page too.
            a.stop();
        }
        Some((info, status))
    }
}

/// IPv4 addresses of this computer on local networks (adapters that are up), physical first.
#[cfg(windows)]
pub fn local_addresses() -> Vec<LocalAddress> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};
    let mut size: u32 = 32 * 1024;
    let mut buf: Vec<u64> = vec![0; size as usize / 8 + 1];
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    for _ in 0..3 {
        // SAFETY: buf holds `size` bytes, 8-byte aligned (u64), as GetAdaptersAddresses requires.
        let rc = unsafe {
            GetAdaptersAddresses(u32::from(AF_INET.0), flags, None, Some(buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>()), &mut size)
        };
        if rc == 111 {
            // ERROR_BUFFER_OVERFLOW: size now holds the needed length.
            buf = vec![0; size as usize / 8 + 1];
            continue;
        }
        if rc != 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut p = buf.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !p.is_null() {
            // SAFETY: p walks the linked list written into buf by the call above.
            let a = unsafe { &*p };
            if a.OperStatus == IfOperStatusUp {
                // SAFETY: FriendlyName is a NUL-terminated wide string owned by buf.
                let name = unsafe { a.FriendlyName.to_string() }.unwrap_or_default();
                let lower = name.to_lowercase();
                let virtual_adapter = ["vethernet", "virtualbox", "vmware", "wsl", "hyper-v", "loopback", "tailscale", "zerotier"]
                    .iter()
                    .any(|v| lower.contains(v));
                let mut u = a.FirstUnicastAddress;
                while !u.is_null() {
                    // SAFETY: as above, list owned by buf.
                    let ua = unsafe { &*u };
                    let sa = ua.Address.lpSockaddr;
                    // SAFETY: lpSockaddr points to a SOCKADDR of the family it declares.
                    if !sa.is_null() && unsafe { (*sa).sa_family } == AF_INET {
                        // SAFETY: AF_INET means a SOCKADDR_IN.
                        let sin = unsafe { &*sa.cast::<SOCKADDR_IN>() };
                        // SAFETY: S_un is a union of the same 4 bytes.
                        let ip = Ipv4Addr::from(u32::from_be(unsafe { sin.sin_addr.S_un.S_addr }));
                        if is_local(&ip) {
                            out.push(LocalAddress { ip: ip.to_string(), adapter: name.clone(), virtual_adapter });
                        }
                    }
                    u = ua.Next;
                }
            }
            p = a.Next;
        }
        out.sort_by_key(|a| (a.virtual_adapter, a.ip.starts_with("169.254.")));
        return out;
    }
    Vec::new()
}

/// macOS (Phase 3b-0): IPv4 addresses of interfaces that are up and not loopback (`getifaddrs`); VPN
/// tunnels and bridges count as virtual.
#[cfg(target_os = "macos")]
pub fn local_addresses() -> Vec<LocalAddress> {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs allocates the list into head; it is freed below with freeifaddrs.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut p = head;
    while !p.is_null() {
        // SAFETY: p walks the list returned by getifaddrs, alive until freeifaddrs.
        let a = unsafe { &*p };
        let up = a.ifa_flags & (libc::IFF_UP as u32) != 0 && a.ifa_flags & (libc::IFF_LOOPBACK as u32) == 0;
        // SAFETY: ifa_addr, when not null, points to a sockaddr of the family it declares.
        if up && !a.ifa_addr.is_null() && i32::from(unsafe { (*a.ifa_addr).sa_family }) == libc::AF_INET {
            // SAFETY: AF_INET means a sockaddr_in; ifa_name is a NUL-terminated C string.
            let (ip, name) = unsafe {
                let sin = &*a.ifa_addr.cast::<libc::sockaddr_in>();
                (Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)), std::ffi::CStr::from_ptr(a.ifa_name).to_string_lossy().into_owned())
            };
            let virtual_adapter = ["utun", "bridge", "vmnet", "awdl", "llw", "gif", "stf", "anpi"].iter().any(|v| name.starts_with(v));
            if is_local(&ip) {
                out.push(LocalAddress { ip: ip.to_string(), adapter: name, virtual_adapter });
            }
        }
        p = a.ifa_next;
    }
    // SAFETY: head came from getifaddrs and is freed once.
    unsafe { libc::freeifaddrs(head) };
    out.sort_by_key(|a| (a.virtual_adapter, a.ip.starts_with("169.254.")));
    out
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn local_addresses() -> Vec<LocalAddress> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::PackSource;

    fn row(id: &str) -> PackRow {
        PackRow {
            id: id.into(),
            kind: PackKind::Zim,
            version: "2026-09".into(),
            title: "T".into(),
            path: "x".into(),
            size_bytes: 100,
            sha256: "a".repeat(64),
            verified: true,
            catalog_seq: Some(2),
            license: None,
            source: PackSource::Download,
            consent_at: None,
            installed_at: 1,
            last_opened_at: None,
            file_stamp: None,
        }
    }

    fn manifest(ids: &[&str], catalog: Value) -> String {
        let packs: Vec<Value> = ids.iter().map(|id| serde_json::json!({ "id": id, "kind": "zim", "version": "2026-09", "title": "T", "sizeBytes": 100, "sha256": "a".repeat(64) })).collect();
        serde_json::json!({ "v": 1, "catalog": catalog, "packs": packs }).to_string()
    }

    #[test]
    fn manifest_must_match_the_selection_and_the_catalog() {
        let rows = vec![row("p1")];
        let cat = Some((b"{}".to_vec(), "sig".to_string()));
        assert!(check_manifest(&manifest(&["p1"], Value::Null), &rows, cat.clone()).is_ok());
        assert!(
            check_manifest(&manifest(&["p1"], serde_json::json!({ "bytes": to_base64(b"{}"), "signature": "sig" })), &rows, cat.clone())
                .is_ok()
        );
        assert!(check_manifest(&manifest(&["p1", "p2"], Value::Null), &rows, cat.clone()).is_err(), "extra pack");
        assert!(check_manifest(&manifest(&["p2"], Value::Null), &rows, cat.clone()).is_err(), "other pack");
        assert!(
            check_manifest(&manifest(&["p1"], serde_json::json!({ "bytes": to_base64(b"[]"), "signature": "sig" })), &rows, cat.clone())
                .is_err(),
            "foreign catalog"
        );
        let tampered = manifest(&["p1"], Value::Null).replace(&"a".repeat(64), &"b".repeat(64));
        assert!(check_manifest(&tampered, &rows, cat).is_err(), "other hash");
    }

    #[test]
    fn only_private_addresses_are_local() {
        assert!(is_local(&"192.168.1.20".parse().expect("ip")));
        assert!(is_local(&"10.0.2.16".parse().expect("ip")));
        assert!(is_local(&"169.254.3.4".parse().expect("ip")));
        assert!(!is_local(&"8.8.8.8".parse().expect("ip")));
        assert!(local_addresses().iter().all(|a| is_local(&a.ip.parse().expect("ip"))));
    }
}
