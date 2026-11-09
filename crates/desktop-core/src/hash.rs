//! Streaming SHA-256 of a whole file and of each catalog chunk in one pass (as `modules/expo-hash`).

use crate::catalog::hex;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDigest {
    pub size_bytes: u64,
    pub sha256: String,
    pub chunk_sha256: Vec<String>,
}

/// Hashes `path`; `progress(hashed, total)` roughly every 16 MiB; stops with `Interrupted` when `cancel` is set.
pub fn digest_file(
    path: &Path,
    chunk_size: u64,
    cancel: Option<&AtomicBool>,
    mut progress: impl FnMut(u64, u64),
) -> io::Result<FileDigest> {
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    let mut whole = Sha256::new();
    let mut chunk = Sha256::new();
    let mut in_chunk = 0u64;
    let mut chunks = Vec::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    let mut last_report = 0u64;
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "hashing cancelled"));
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let data = &buf[..n];
        whole.update(data);
        let mut offset = 0usize;
        while offset < n {
            let take = ((chunk_size - in_chunk) as usize).min(n - offset);
            chunk.update(&data[offset..offset + take]);
            in_chunk += take as u64;
            offset += take;
            if in_chunk == chunk_size {
                chunks.push(hex(&std::mem::take(&mut chunk).finalize()));
                in_chunk = 0;
            }
        }
        done += n as u64;
        if done - last_report >= 16 << 20 {
            last_report = done;
            progress(done, total);
        }
    }
    if in_chunk > 0 || chunks.is_empty() {
        chunks.push(hex(&chunk.finalize()));
    }
    progress(done, total);
    Ok(FileDigest { size_bytes: done, sha256: hex(&whole.finalize()), chunk_sha256: chunks })
}

/// SHA-256 of each complete `chunk_size` slice at the start of a partial file (resume point).
pub fn chunk_hashes_prefix(path: &Path, chunk_size: u64) -> io::Result<Vec<String>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let complete = len / chunk_size;
    let mut out = Vec::with_capacity(complete as usize);
    let mut buf = vec![0u8; 1 << 20];
    for _ in 0..complete {
        let mut h = Sha256::new();
        let mut left = chunk_size;
        while left > 0 {
            let want = (buf.len() as u64).min(left) as usize;
            file.read_exact(&mut buf[..want])?;
            h.update(&buf[..want]);
            left -= want as u64;
        }
        out.push(hex(&h.finalize()));
    }
    Ok(out)
}

/// Identity of a file as the OS reports it without reading its bytes: size, last write and change
/// times, volume and file id (Windows) or inode (Unix). Any replacement or write changes
/// it, also when the old modification time is restored (the change time and the file id cannot be set
/// through the usual APIs). Equal stamps let startup skip a full hash; different stamps force one.
#[cfg(windows)]
pub fn file_stamp(path: &Path) -> io::Result<String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    };
    let file = File::open(path)?;
    let handle = HANDLE(file.as_raw_handle());
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is an open file handle owned by `file` for the whole call; `info` is a valid out pointer.
    unsafe { GetFileInformationByHandle(handle, &mut info) }.map_err(|e| io::Error::other(e.to_string()))?;
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: as above; the buffer is a FILE_BASIC_INFO and its exact size is passed.
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    }
    .map_err(|e| io::Error::other(e.to_string()))?;
    let size = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok(format!("w1:{size}:{}:{index}:{}:{}", info.dwVolumeSerialNumber, basic.LastWriteTime, basic.ChangeTime))
}

#[cfg(unix)]
pub fn file_stamp(path: &Path) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path)?;
    // No device number: removable drives get a new one at every mount, which would force a full hash of
    // every pack at each start; inode and change time still change with any replacement or write.
    Ok(format!("u2:{}:{}:{}.{}:{}.{}", m.size(), m.ino(), m.mtime(), m.mtime_nsec(), m.ctime(), m.ctime_nsec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sha256_hex;

    #[test]
    fn whole_and_chunk_hashes_match_independent_hashing() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("f.bin");
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).expect("write");
        let d = digest_file(&path, 65_536, None, |_, _| {}).expect("digest");
        assert_eq!(d.size_bytes, 300_000);
        assert_eq!(d.sha256, sha256_hex(&data));
        assert_eq!(d.chunk_sha256.len(), 5);
        assert_eq!(d.chunk_sha256[0], sha256_hex(&data[..65_536]));
        assert_eq!(d.chunk_sha256[4], sha256_hex(&data[262_144..]));
        assert_eq!(chunk_hashes_prefix(&path, 65_536).expect("prefix"), d.chunk_sha256[..4].to_vec());
    }

    #[test]
    fn file_stamp_is_stable_and_changes_on_same_size_writes() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("s.bin");
        std::fs::write(&path, b"abcdef").expect("write");
        let first = file_stamp(&path).expect("stamp");
        assert_eq!(file_stamp(&path).expect("stamp"), first);
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mtime = std::fs::metadata(&path).expect("meta").modified().expect("mtime");
        std::fs::write(&path, b"abcdeX").expect("rewrite");
        File::options().write(true).open(&path).expect("open").set_modified(mtime).expect("restore mtime");
        assert_ne!(file_stamp(&path).expect("stamp"), first, "same size and mtime, but written again");
    }

    #[test]
    fn empty_file_has_one_chunk_and_cancel_stops() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("e.bin");
        std::fs::write(&path, b"").expect("write");
        assert_eq!(digest_file(&path, 64, None, |_, _| {}).expect("digest").chunk_sha256.len(), 1);
        let cancel = AtomicBool::new(true);
        assert_eq!(digest_file(&path, 64, Some(&cancel), |_, _| {}).unwrap_err().kind(), io::ErrorKind::Interrupted);
    }
}
