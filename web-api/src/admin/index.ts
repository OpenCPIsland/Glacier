// Preload entry: BUN_OPTIONS=--preload=<this file>. Only a shim: every
// import that could fail (a missing or broken file, a half-finished
// deploy) happens inside the dynamic import, so a broken admin module
// is logged and the web-api starts as plain iceberg.
try {
  await import("./main.ts");
} catch (err) {
  console.error(`[ADMIN] web-api module failed to start: ${(err as Error).message}`);
}

export {};
