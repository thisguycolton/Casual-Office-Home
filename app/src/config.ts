/** Central, validated configuration. All runtime settings come from environment variables. */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Directory holding the built editor bundles (docs, sheets, slides, pdf, fonts). */
  editorsDir: string;
  /** Directory holding the built central web UI. */
  publicDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got "${env.PORT}"`);
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir: env.DATA_DIR ?? '/data',
    editorsDir: env.EDITORS_DIR ?? '/app/editors',
    publicDir: env.PUBLIC_DIR ?? '/app/public',
  };
}
