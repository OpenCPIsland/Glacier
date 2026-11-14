// Panel configuration from the environment. Anything missing or weak stops
// startup with every problem listed, so a half-configured panel never runs.
import { resolve } from "node:path";

export interface PanelConfig {
  port: number;
  host: string;
  team: string;
  aud: string;
  secret: string;
  csrfKey: string;
  owners: string[];
  dbPath: string;
  webapiUrl: string;
  gameUrl: string;
  /** Where uploaded CDN release zips are staged for the web API to import (it must be able to read this folder). */
  uploadDir: string;
  uploadMaxBytes: number;
  testJwksFile?: string;
}

export function loadConfig(env: Record<string, string | undefined>): PanelConfig {
  const problems: string[] = [];
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) problems.push(`${k} is missing`); return v ?? ""; };
  const port = (k: string, d: number) => {
    const v = env[k] === undefined || env[k] === "" ? d : Number(env[k]);
    if (!Number.isInteger(v) || v < 0 || v > 65535) problems.push(`${k} must be a port number`);
    return v;
  };
  const cfg: PanelConfig = {
    port: port("ADMIN_PANEL_PORT", 8090),
    host: need("PANEL_HOST"),
    team: need("CF_ACCESS_TEAM"),
    aud: need("CF_ACCESS_AUD"),
    secret: need("ADMIN_PANEL_SECRET"),
    csrfKey: need("PANEL_CSRF_KEY"),
    owners: (env.PANEL_OWNERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    dbPath: env.PANEL_DB?.trim() || resolve(import.meta.dir, "../admin.db"),
    webapiUrl: `http://127.0.0.1:${port("WEBAPI_ADMIN_PORT", 8091)}`,
    gameUrl: `http://127.0.0.1:${port("SFS_ADMIN_PORT", 8092)}`,
    uploadDir: env.CDN_UPLOAD_DIR?.trim() || "/var/lib/iceberg-uploads",
    uploadMaxBytes: env.CDN_UPLOAD_MAX_BYTES === undefined || env.CDN_UPLOAD_MAX_BYTES === "" ? 100 * 1024 * 1024 : Number(env.CDN_UPLOAD_MAX_BYTES),
  };
  if (!Number.isInteger(cfg.uploadMaxBytes) || cfg.uploadMaxBytes < 1) problems.push("CDN_UPLOAD_MAX_BYTES must be a positive whole number");
  if (cfg.secret && !/^[0-9a-f]{64,}$/i.test(cfg.secret)) problems.push("ADMIN_PANEL_SECRET must be at least 64 hex characters (openssl rand -hex 32)");
  if (cfg.csrfKey && cfg.csrfKey.length < 32) problems.push("PANEL_CSRF_KEY must be at least 32 characters");
  if (cfg.owners.length === 0) problems.push("PANEL_OWNERS is missing (comma-separated owner emails)");
  if (cfg.host && !/^[a-z0-9.-]+$/i.test(cfg.host)) problems.push("PANEL_HOST must be a bare hostname, e.g. admin.example.com");
  if (env.PANEL_TEST_JWKS_FILE) {
    if (env.NODE_ENV === "test") cfg.testJwksFile = env.PANEL_TEST_JWKS_FILE;
    else problems.push("PANEL_TEST_JWKS_FILE is ignored outside NODE_ENV=test; remove it");
  }
  if (problems.length) throw new Error(`admin panel configuration:\n  - ${problems.join("\n  - ")}`);
  return cfg;
}
