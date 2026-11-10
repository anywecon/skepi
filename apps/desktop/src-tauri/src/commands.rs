//! The narrow IPC surface of the main window (capabilities/main.json lists exactly these). Paths never
//! come from the webview: packs are named by id and resolved from app.db; files and folders the user
//! picks come from native dialogs opened here. Errors are strings with a stable `ERR_*` prefix.

use crate::protocols::{MAIN_LABEL, VIEWER_LABEL};
use crate::state::AppState;
use desktop_core::catalog::PackKind;
use desktop_core::content::{CatalogSummary, ReconcileReport, VerifyResult};
use desktop_core::db::{PackRow, UI_SETTINGS};
use desktop_core::device::{CpuInfo, DeviceSnapshot};
use desktop_core::download::DownloadProgress;
use desktop_core::inference::{GenerateRequest, GenerateResult, GpuDevice, LoadOptions, LoadedModel};
use desktop_core::station::server::ServerStatus;
use desktop_core::station::{LocalAddress, StationInfo};
use desktop_core::zim::{ArchiveInfo, ArticleHtml, ArticleText, SearchHit};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

// ---- knowledge ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArchive {
    #[serde(flatten)]
    pub info: ArchiveInfo,
    pub pack_id: String,
    pub verified: bool,
}

/// Opens every verified ZIM pack and the unverified ones the user consented to (never anything else).
#[tauri::command]
pub async fn zim_open_installed(state: State<'_, AppState>) -> Res<Vec<OpenArchive>> {
    let zim = state.zim.clone();
    let store = state.store.clone();
    blocking(move || {
        zim.close_all();
        zim.set_roots(vec![store.root()]);
        let mut out = Vec::new();
        // Verified packs first: a later file declaring an open archive's UUID is refused.
        for p in store.openable_zims().map_err(err)? {
            // A file libzim refuses (corrupt, not a ZIM, or a duplicate UUID) is skipped; the Library shows it.
            let Ok(info) = zim.open(std::path::Path::new(&p.path)) else { continue };
            // The archive served under this id must be this pack's file before it carries its label.
            if desktop_core::zim::dunce_canonical(std::path::Path::new(&p.path)).as_deref() != Some(std::path::Path::new(&info.path)) {
                continue;
            }
            out.push(OpenArchive { info, pack_id: p.id, verified: p.verified });
        }
        Ok(out)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hits {
    pub hits: Vec<SearchHit>,
    pub native_ms: f64,
}

#[tauri::command]
pub async fn zim_suggest(state: State<'_, AppState>, query: String, limit: u32, archive_ids: Option<Vec<String>>) -> Res<Hits> {
    let zim = state.zim.clone();
    blocking(move || {
        let t = Instant::now();
        let hits = zim.suggest(&query, limit, archive_ids.as_deref()).map_err(err)?;
        Ok(Hits { hits, native_ms: t.elapsed().as_secs_f64() * 1000.0 })
    })
    .await
}

#[tauri::command]
pub async fn zim_search(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
    archive_ids: Option<Vec<String>>,
    with_snippets: bool,
) -> Res<Hits> {
    let zim = state.zim.clone();
    blocking(move || {
        let t = Instant::now();
        let hits = zim.search(&query, limit, archive_ids.as_deref(), with_snippets).map_err(err)?;
        Ok(Hits { hits, native_ms: t.elapsed().as_secs_f64() * 1000.0 })
    })
    .await
}

#[tauri::command]
pub async fn zim_article(state: State<'_, AppState>, archive_id: String, path: String) -> Res<ArticleHtml> {
    let zim = state.zim.clone();
    blocking(move || zim.article_html(&archive_id, &path).map_err(err)).await
}

#[tauri::command]
pub async fn zim_plain_text(state: State<'_, AppState>, archive_id: String, path: String) -> Res<ArticleText> {
    let zim = state.zim.clone();
    blocking(move || zim.plain_text(&archive_id, &path).map_err(err)).await
}

/// WebView2 browser arguments shared by every webview (one WebView2 environment per data folder):
/// Tauri's defaults (mini menu, PDF UI, SmartScreen off); the runtime's Microsoft-account integration
/// off (`msOneAuthWAM`, `msLoadOneAuthInBackground`, `msEdgeOSAccountInfoSubstrate`: without them the
/// browser process fetched the Windows account's profile from substrate.office.com at every start,
/// measured with apps/desktop/e2e/egress.mjs); no background networking, component updates,
/// domain reliability reports or pings, no DNS prefetching (the viewer also strips resource hints and
/// sends `X-DNS-Prefetch-Control: off`). docs/threat-model.md, "WebView2 runtime egress".
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msOneAuthWAM,msLoadOneAuthInBackground,msEdgeOSAccountInfoSubstrate --disable-background-networking --disable-component-update --disable-domain-reliability --no-pings --dns-prefetch-disable";

/// The `zim` protocol's origin: WebView2 serves custom schemes as `http://<scheme>.localhost`, WKWebView
/// (macOS) as `<scheme>://localhost`.
#[cfg(not(target_os = "macos"))]
const VIEWER_ORIGIN: &str = "http://zim.localhost";
#[cfg(target_os = "macos")]
const VIEWER_ORIGIN: &str = "zim://localhost";

fn viewer_url(archive_id: &str, path: &str, anchor: Option<&str>) -> Res<Url> {
    let encoded: String = path
        .split('/')
        .map(|s| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/");
    let mut url = Url::parse(&format!("{VIEWER_ORIGIN}/{archive_id}/{encoded}")).map_err(err)?;
    // Section anchors from Layer 1 (ZIM heading ids): a fragment never reaches the protocol handler.
    if let Some(a) = anchor.filter(|a| !a.is_empty() && a.len() < 256) {
        url.set_fragment(Some(a));
    }
    Ok(url)
}

fn is_viewer_url(url: &Url) -> bool {
    (url.scheme() == "http" && url.host_str() == Some("zim.localhost")) || url.scheme() == "zim"
}

/// Opens an article in the sealed viewer window: JavaScript off, no IPC capability, no navigation
/// outside zim://, no new windows, no downloads, nothing persisted. External links are reported to
/// the main window as text (`viewer-external`), never opened.
#[tauri::command]
pub async fn viewer_open(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_id: String,
    path: String,
    title: String,
    dark: bool,
    anchor: Option<String>,
) -> Res<()> {
    if !state.zim.is_open(&archive_id) {
        return Err("ERR_ZIM_NOT_OPEN: archive is not open".into());
    }
    state.viewer_dark.store(dark, Ordering::Relaxed);
    let url = viewer_url(&archive_id, &path, anchor.as_deref())?;
    if let Some(w) = app.get_webview_window(VIEWER_LABEL) {
        w.navigate(url).map_err(err)?;
        let _ = w.set_title(&title);
        let _ = w.set_focus();
        return Ok(());
    }
    let nav_app = app.clone();
    let win_app = app.clone();
    WebviewWindowBuilder::new(&app, VIEWER_LABEL, WebviewUrl::External(url))
        .title(title)
        .inner_size(960.0, 900.0)
        .disable_javascript()
        .incognito(true)
        .devtools(false)
        .additional_browser_args(BROWSER_ARGS)
        .on_navigation(move |u| {
            if is_viewer_url(u) {
                return true;
            }
            let _ = nav_app.emit_to(MAIN_LABEL, "viewer-external", u.as_str());
            false
        })
        .on_new_window(move |u, _| {
            let _ = win_app.emit_to(MAIN_LABEL, "viewer-external", u.as_str());
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .build()
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn viewer_close(app: AppHandle) -> Res<()> {
    if let Some(w) = app.get_webview_window(VIEWER_LABEL) {
        w.close().map_err(err)?;
    }
    Ok(())
}

// ---- inference ----

#[tauri::command]
pub async fn llm_load(
    state: State<'_, AppState>,
    model_pack_id: String,
    options: LoadOptions,
    on_progress: Channel<f32>,
) -> Res<LoadedModel> {
    let pack = state.store.db.get_pack(&model_pack_id).map_err(err)?.ok_or("ERR_MODEL: not installed")?;
    // Unverified models are never loaded (app.db forbids them too).
    if pack.kind != PackKind::Gguf || !pack.verified {
        return Err("ERR_MODEL: only verified GGUF models are loaded".into());
    }
    let engine = state.inference()?.clone();
    if let Some(cur) = engine.current()
        && cur.model_id == pack.id
    {
        let _ = on_progress.send(1.0);
        return Ok(cur);
    }
    let path = PathBuf::from(&pack.path);
    blocking(move || {
        engine.load(
            pack.id,
            path,
            options,
            Some(Box::new(move |f| {
                let _ = on_progress.send(f);
            })),
        )
    })
    .await
}

#[tauri::command]
pub async fn llm_generate(state: State<'_, AppState>, request: GenerateRequest, on_token: Channel<String>) -> Res<GenerateResult> {
    let engine = state.inference()?.clone();
    let abort = state.new_abort();
    blocking(move || {
        engine.generate(
            request,
            Box::new(move |t| {
                let _ = on_token.send(t.to_owned());
            }),
            abort,
        )
    })
    .await
}

#[tauri::command]
pub async fn llm_abort(state: State<'_, AppState>) -> Res<()> {
    state.abort_generation();
    Ok(())
}

#[tauri::command]
pub async fn llm_unload(state: State<'_, AppState>) -> Res<()> {
    if let Ok(engine) = state.inference() {
        let engine = engine.clone();
        blocking(move || {
            engine.unload();
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub snapshot: DeviceSnapshot,
    pub cpu: CpuInfo,
    pub gpu: Option<GpuDevice>,
    pub loaded: Option<LoadedModel>,
}

#[tauri::command]
pub async fn device_info(state: State<'_, AppState>) -> Res<DeviceInfo> {
    let root = state.store.root();
    let loaded = state.inference().ok().and_then(|i| i.current());
    blocking(move || {
        Ok(DeviceInfo {
            snapshot: desktop_core::device::snapshot(&root),
            cpu: desktop_core::device::cpu_info(),
            gpu: desktop_core::inference::best_gpu(),
            loaded,
        })
    })
    .await
}

// ---- content ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentState {
    pub root: String,
    pub catalog: CatalogSummary,
    pub packs: Vec<PackRow>,
}

fn content_state_of(state: &AppState) -> Res<ContentState> {
    Ok(ContentState {
        root: state.store.root().display().to_string(),
        catalog: state.store.summary(),
        packs: state.store.list_installed().map_err(err)?,
    })
}

#[tauri::command]
pub async fn content_state(state: State<'_, AppState>) -> Res<ContentState> {
    content_state_of(&state)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashProgress {
    pub file: String,
    pub percent: u32,
}

#[tauri::command]
pub async fn content_reconcile(state: State<'_, AppState>, on_progress: Channel<HashProgress>) -> Res<ReconcileReport> {
    let store = state.store.clone();
    blocking(move || {
        store
            .reconcile(|file, done, total| {
                let _ =
                    on_progress.send(HashProgress { file: file.to_owned(), percent: (done * 100).checked_div(total).unwrap_or(0) as u32 });
            })
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn content_download(state: State<'_, AppState>, pack_id: String, on_progress: Channel<DownloadProgress>) -> Res<PackRow> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.downloads.lock().unwrap_or_else(|p| p.into_inner()).insert(pack_id.clone(), cancel.clone());
    let r = desktop_core::download::download_pack(state.store.clone(), &state.http, &pack_id, cancel, |p| {
        let _ = on_progress.send(p);
    })
    .await
    .map_err(err);
    state.downloads.lock().unwrap_or_else(|p| p.into_inner()).remove(&pack_id);
    r
}

#[tauri::command]
pub async fn content_cancel(state: State<'_, AppState>, pack_id: String) -> Res<()> {
    if let Some(c) = state.downloads.lock().unwrap_or_else(|p| p.into_inner()).get(&pack_id) {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn content_check_update(state: State<'_, AppState>) -> Res<Option<u64>> {
    let sequence = desktop_core::download::check_catalog_update(&state.store, &state.http).await.map_err(err)?;
    if sequence.is_some() {
        // Hashes the new catalog revokes lose their trust now, not at the next start (only that pass: a
        // download or import in progress is left alone). Open archives and places files are closed so that
        // only packs still trusted open again, and a running Station stops (it shares a snapshot of the packs).
        let store = state.store.clone();
        let revoked = blocking(move || store.apply_revocations().map_err(err)).await?;
        if !revoked.is_empty() {
            state.zim.close_all();
            state.places.close_all();
            state.station.stop("a pack it shared was revoked by the signed catalog");
        }
    }
    Ok(sequence)
}

/// Opens the native file picker; the chosen file is copied into the content folder and checked.
#[tauri::command]
pub async fn content_import(app: AppHandle, state: State<'_, AppState>, on_progress: Channel<HashProgress>) -> Res<Option<PackRow>> {
    let picked = app
        .dialog()
        .file()
        .add_filter("SKEPI content (ZIM, GGUF, PMTiles, places)", &["zim", "gguf", "pmtiles", "sqlite"])
        .blocking_pick_file();
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(err)?;
    let store = state.store.clone();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    blocking(move || {
        store
            .import_file(&path, None, |done, total| {
                let _ = on_progress.send(HashProgress { file: name.clone(), percent: (done * 100).checked_div(total).unwrap_or(0) as u32 });
            })
            .map(Some)
            .map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn content_verify(state: State<'_, AppState>, pack_id: String) -> Res<VerifyResult> {
    let store = state.store.clone();
    blocking(move || store.verify(&pack_id, None, |_, _| {}).map_err(err)).await
}

#[tauri::command]
pub async fn content_remove(state: State<'_, AppState>, pack_id: String) -> Res<()> {
    if let Ok(Some(p)) = state.store.db.get_pack(&pack_id)
        && p.kind == PackKind::Zim
    {
        // Close the archive before deleting its file (Windows keeps open files locked).
        state.zim.close_all();
    }
    state.places.close_all();
    state.store.remove(&pack_id).map_err(err)
}

#[tauri::command]
pub async fn content_consent(state: State<'_, AppState>, pack_id: String) -> Res<()> {
    state.store.set_consent(&pack_id).map_err(err)
}

/// Native folder picker for the content folder (another drive or a USB stick works); the new folder
/// is reconciled (files there are hashed once and registered when the catalog knows them).
#[tauri::command]
pub async fn content_choose_folder(app: AppHandle, state: State<'_, AppState>) -> Res<Option<ContentState>> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let root = folder.into_path().map_err(err)?;
    state.zim.close_all();
    state.places.close_all();
    state.store.set_root(root.clone()).map_err(err)?;
    state.zim.set_roots(vec![root.clone()]);
    state.store.db.set_setting("desktop.contentRoot", &serde_json::Value::from(root.display().to_string())).map_err(err)?;
    let store = state.store.clone();
    blocking(move || store.reconcile(|_, _, _| {}).map(|_| ()).map_err(err)).await?;
    content_state_of(&state).map(Some)
}

// ---- settings ----

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, key: String) -> Res<Option<serde_json::Value>> {
    if !UI_SETTINGS.contains(&key.as_str()) {
        return Err(format!("ERR_SETTING: {key} is not readable from the UI"));
    }
    state.store.db.get_setting(&key).map_err(err)
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Res<()> {
    if !UI_SETTINGS.contains(&key.as_str()) || key == "desktop.contentRoot" {
        return Err(format!("ERR_SETTING: {key} is not writable from the UI"));
    }
    state.store.db.set_setting(&key, &value).map_err(err)
}

// ---- places ----

#[tauri::command]
pub async fn places_query(
    state: State<'_, AppState>,
    pack_id: String,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Res<Vec<serde_json::Map<String, serde_json::Value>>> {
    if !state.places.is_open(&pack_id) {
        let pack = state.store.db.get_pack(&pack_id).map_err(err)?.ok_or("ERR_PLACES: not installed")?;
        // Only verified places packs are opened (a malicious SQLite never reaches the parser).
        if pack.kind != PackKind::Places || !pack.verified {
            return Err("ERR_PLACES: only verified places packs are opened".into());
        }
        state.places.open(&pack_id, std::path::Path::new(&pack.path)).map_err(err)?;
    }
    state.places.query(&pack_id, &sql, &params).map_err(err)
}

// ---- Station mode ----

#[tauri::command]
pub async fn station_addresses() -> Res<Vec<LocalAddress>> {
    Ok(desktop_core::station::local_addresses())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkChoice {
    pub file_name: String,
    pub size_bytes: u64,
    /// Read from the APK's signing block, not verified: the UI shows it to compare, never as a verdict.
    pub signing_sha256: String,
}

/// Native picker for the APK offered on the install page (the webview never names a path).
/// Longest problem report the UI may save (question, shown text, sources: a few KB in practice).
const MAX_REPORT_BYTES: usize = 256 * 1024;

/// "Report a problem with this answer" -> "Save for later": a native save dialog (the webview never
/// names a path) writes the prepared text as a .txt file. Nothing is sent anywhere.
#[tauri::command]
pub async fn report_save(app: AppHandle, text: String) -> Res<Option<String>> {
    if text.len() > MAX_REPORT_BYTES {
        return Err("ERR_REPORT_TOO_LARGE: report text is too large".into());
    }
    let Some(file) = app.dialog().file().add_filter("Text", &["txt"]).set_file_name("skepi-problem-report.txt").blocking_save_file() else {
        return Ok(None);
    };
    let mut path = file.into_path().map_err(err)?;
    if path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() != Some("txt") {
        path.set_extension("txt");
    }
    let target = path.clone();
    blocking(move || std::fs::write(&target, text.as_bytes()).map_err(err)).await?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn station_choose_apk(app: AppHandle, state: State<'_, AppState>) -> Res<Option<ApkChoice>> {
    let Some(file) = app.dialog().file().add_filter("Android app (APK)", &["apk"]).blocking_pick_file() else { return Ok(None) };
    let path = file.into_path().map_err(err)?;
    let sha = desktop_core::station::apk::signing_cert_sha256(&path).map_err(|e| format!("ERR_STATION_APK: {e}"))?;
    let choice = ApkChoice {
        file_name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        signing_sha256: sha,
    };
    *state.apk.lock().unwrap_or_else(|p| p.into_inner()) = Some(path);
    Ok(Some(choice))
}

#[tauri::command]
pub async fn station_start(
    state: State<'_, AppState>,
    host: String,
    pack_ids: Vec<String>,
    manifest: String,
    with_apk: bool,
) -> Res<StationInfo> {
    let apk = if with_apk { state.apk.lock().unwrap_or_else(|p| p.into_inner()).clone() } else { None };
    if with_apk && apk.is_none() {
        return Err("ERR_STATION_APK: choose an APK first".into());
    }
    state.station.start(&state.store, &host, &pack_ids, &manifest, apk, desktop_core::station::IDLE_TIMEOUT).await.map_err(err)
}

#[tauri::command]
pub async fn station_stop(state: State<'_, AppState>) -> Res<()> {
    state.station.stop("stopped");
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationState {
    pub info: Option<StationInfo>,
    pub status: Option<ServerStatus>,
}

#[tauri::command]
pub async fn station_status(state: State<'_, AppState>) -> Res<StationState> {
    Ok(match state.station.status() {
        Some((info, status)) => StationState { info: Some(info), status: Some(status) },
        None => StationState { info: None, status: None },
    })
}
