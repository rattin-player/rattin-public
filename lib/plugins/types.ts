// lib/plugins/types.ts
// Type definitions for the plugin system. Self-contained — no imports from lib/types.ts
// to avoid circular dependencies.

export interface SearchQuery {
  query: string;
  type: "movie" | "tv";
  season?: number;
  episode?: number;
  imdbId?: string;
}

export interface SearchResult {
  infoHash: string;
  name: string;
  size: number;
  seeders: number;
  leechers?: number;
  source: string;
  fileIdx?: number;
  languages?: string[];
  hasSubs?: boolean;
  seasonPack?: boolean;
}

export interface PluginIndexEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  downloadUrl: string;
  sha256: string;
  version: string;
  apiVersion: number;
}

export interface PluginStatus {
  installed: boolean;
  plugin: { id: string; name: string; version: string } | null;
  running: boolean;
}

export interface PluginHealth {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
}

export interface AvailabilityItem {
  title: string;
  year?: number;
  type: string;
}

export interface AvailabilityResult {
  available: number[];
}

/**
 * The interface that ServerContext and routes use to interact with the plugin.
 * The concrete implementation is PluginRegistryImpl in lib/plugins/registry.ts.
 */
export interface PluginRegistry {
  isInstalled(): boolean;
  isRunning(): boolean;
  getStatus(): PluginStatus;
  search(query: SearchQuery): Promise<SearchResult[]>;
  searchBatch(queries: SearchQuery[]): Promise<SearchResult[][]>;
  availability(items: AvailabilityItem[]): Promise<AvailabilityResult>;
  installFromUrl(url: string, entry: PluginIndexEntry): Promise<void>;
  installFromFile(filePath: string): Promise<void>;
  reload(): Promise<void>;
  uninstall(): Promise<void>;
  stop(): void;
}
