import { NativeModule, requireNativeModule } from 'expo';

export type NativeDownloadStatus = 'pending' | 'running' | 'paused' | 'successful' | 'failed' | 'unknown';

export interface NativeDownload {
  status: NativeDownloadStatus;
  /** DownloadManager COLUMN_REASON (HTTP status or ERROR_* / PAUSED_* code). */
  reason: number;
  bytes: number;
  totalBytes: number;
}

export interface NetworkState {
  connected: boolean;
  wifi: boolean;
  metered: boolean;
}

export interface ContentFileInfo {
  exists: boolean;
  sizeBytes: number;
  path: string;
  /** Size, device, inode, modification and change time (null: no file). Equal stamps: unchanged file. */
  stamp: string | null;
}

export interface ContentDirEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface ImportedFile {
  displayName: string;
  sizeBytes: number;
  relativePath: string;
  path: string;
}

export interface EmbeddedCatalog {
  /** catalog.json bytes, base64 (verified over the exact bytes). */
  catalog: string;
  signature: string;
  /** Pinned public keys (JSON). */
  pinnedKeys: string;
  /** `{ "updateUrls": [...] }` (JSON) or null when this build has no catalog update source. */
  sources: string | null;
}

export interface NetworkLogEntry {
  host: string;
  port: number;
  path: string;
  atMs: number;
}

type ContentStoreEvents = { onImportProgress: (e: { copiedBytes: number; totalBytes: number }) => void };

declare class ExpoContentStoreNativeModule extends NativeModule<ContentStoreEvents> {
  getContentRoot(): string;
  getNetworkState(): NetworkState;
  getFreeBytes(): number;
  requiredFreeBytes(sizeBytes: number): number;
  startDownload(url: string, fileName: string, title: string, allowMetered: boolean): Promise<number>;
  queryDownload(id: number): NativeDownload | null;
  removeDownload(id: number): boolean;
  /** Moves a finished download under the content root (Android 7–10) and returns its absolute path. */
  adoptDownload(fileName: string): Promise<string>;
  /**
   * Android 7–10: moves packs of older versions from external into internal storage. `kept`: content
   * paths (`zim/<file>`) that could not move and stay where they are (their rows must stay too).
   */
  migrateLegacyContent(): Promise<{ moved: number; kept: string[] }>;
  fileInfo(relativePath: string): ContentFileInfo;
  listDir(dir: 'zim' | 'models' | 'maps' | 'tmp'): ContentDirEntry[];
  installFile(fromRelative: string, toRelative: string): Promise<string>;
  deleteFile(relativePath: string): Promise<boolean>;
  importFromUri(uri: string, fileName: string): Promise<ImportedFile>;
  readSmallFileBase64(relativePath: string): Promise<string | null>;
  readEmbeddedCatalog(): Promise<EmbeddedCatalog | null>;
  writeAcceptedCatalog(catalogBase64: string, signature: string): Promise<void>;
  readAcceptedCatalog(): Promise<{ catalog: string; signature: string } | null>;
  getNetworkLog(): NetworkLogEntry[];
  clearNetworkLog(): void;
}

export default requireNativeModule<ExpoContentStoreNativeModule>('ExpoContentStore');
