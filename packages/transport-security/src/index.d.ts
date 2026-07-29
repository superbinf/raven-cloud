export interface TlsServerMaterial {
  certificate: string | Buffer;
  privateKey: string | Buffer;
  certificateAuthority?: string | Buffer;
}

export interface EncryptedHttpUrlOptions {
  label?: string;
  allowLoopbackHttp?: boolean;
}

export interface TlsServerFileConfig {
  nodeEnv?: string;
  certificateFile?: string;
  privateKeyFile?: string;
  certificateAuthorityFile?: string;
  readFile: (path: string) => string | Buffer;
  variablePrefix?: string;
}

export const TLS_13_AES_256_GCM_OPTIONS: Readonly<{
  minVersion: "TLSv1.3";
  maxVersion: "TLSv1.3";
  ciphers: "TLS_AES_256_GCM_SHA384";
  ecdhCurve: "X25519:P-256";
  honorCipherOrder: true;
}>;

export function createTlsServerOptions(material: TlsServerMaterial): Record<string, unknown>;
export function resolveTlsServerConfig(config: TlsServerFileConfig): {
  enabled: boolean;
  protocol: "http" | "https";
  serverOptions: Record<string, unknown> | null;
};
export function isLoopbackHostname(value: unknown): boolean;
export function assertEncryptedHttpUrl(value: unknown, options?: EncryptedHttpUrlOptions): URL;

export interface HostAllowlistEntry {
  host: string;
  port: number | null;
}

export interface GuardedHttpClientOptions {
  allowlist?: HostAllowlistEntry[];
  allowLoopback?: boolean;
  maxBytes?: number;
  maxRedirects?: number;
  redirect?: "error" | "manual" | "follow";
}

export interface GuardedRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GuardedResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function isPrivateAddress(address: unknown): boolean;
export function parseHostAllowlist(value: unknown): HostAllowlistEntry[];
export function isHostAllowlisted(host: unknown, port: unknown, allowlist?: HostAllowlistEntry[]): boolean;
export function createGuardedHttpClient(
  options?: GuardedHttpClientOptions
): (url: string | URL, options?: GuardedRequestOptions) => Promise<GuardedResponse>;

export interface SvgIconValidationOptions {
  maxBytes?: number;
  statusCode?: number;
}

export function isSvgIconContent(content: string | Buffer | Uint8Array, mediaType?: unknown): boolean;
export function assertSafeSvgIcon(content: string | Buffer | Uint8Array, options?: SvgIconValidationOptions): Buffer;
export function svgIconResponseHeaders(): Record<string, string>;
