import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// The gateway, the snapshotter, the rooms service and the page run against
// the Felix stack `dev/up.sh` started, with the snapshotter's token and the
// certificate it wrote.
// With CANVAS_E2E_URL the tests instead use an install already serving there.
const installed = process.env.CANVAS_E2E_URL;
const root = fileURLToPath(new URL("..", import.meta.url));
const state = `${root}dev/state`;
const token = (name: string) =>
  existsSync(`${state}/${name}.token`) ? readFileSync(`${state}/${name}.token`, "utf8").trim() : "";

// The canvas's scope file with a short member TTL, so a vanished tab drops out
// within a test's time.
function e2eScopeFile(): string {
  const scope = readFileSync(`${root}deploy/scope.toml`, "utf8");
  for (const line of ["ttl_s = 30", "sessions_per_principal = 16"]) {
    if (!scope.includes(line)) throw new Error(`deploy/scope.toml has no ${line}`);
  }
  mkdirSync(state, { recursive: true });
  // The tests' Writers stand in for many people, all signed in as ana, at up
  // to 300 writes a second each, so the gateway's write rates and per-person
  // session cap are off here. The browsers keep their own pacing, and the
  // installed-image runs keep the limits.
  const unlimited = [
    "[limits.session]",
    "writes_per_s = 0",
    "bytes_per_s = 0",
    "[limits.principal]",
    "writes_per_s = 0",
    "bytes_per_s = 0",
  ].join("\n");
  const local = scope
    .replace("ttl_s = 30", "ttl_s = 6")
    .replace("sessions_per_principal = 16", "sessions_per_principal = 0");
  writeFileSync(`${state}/scope.e2e.toml`, `${local}\n${unlimited}\n`);
  return `${state}/scope.e2e.toml`;
}

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  // The tests share the dev stack's rooms.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: installed ?? "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: installed
    ? []
    : [
        {
          // felix-gateway 0.3.1, from `cargo install felix-gateway --version 0.3.1`.
          command: process.env.CANVAS_GATEWAY_BIN ?? "felix-gateway",
          cwd: root,
          url: "http://127.0.0.1:8787/metrics",
          env: {
            GATEWAY_FELIX_CA_FILE: `${state}/broker-cert.pem`,
            GATEWAY_SCOPE_FILE: e2eScopeFile(),
            GATEWAY_TENANT: "canvas",
            GATEWAY_OIDC_CLIENT_ID: "felix-canvas",
            GATEWAY_FELIX_BROKERS: process.env.CANVAS_FELIX_BROKERS ?? "127.0.0.1:5000",
          },
          reuseExistingServer: !process.env.CI,
        },
        {
          command:
            "npm run build -w @felix-canvas/snapshotter && npm start -w @felix-canvas/snapshotter",
          cwd: root,
          url: "http://127.0.0.1:8788/",
          env: {
            CANVAS_FELIX_TOKEN: token("snapshotter"),
            CANVAS_FELIX_CA_FILE: `${state}/broker-cert.pem`,
          },
          reuseExistingServer: !process.env.CI,
        },
        {
          // Built by the snapshotter's command above; web servers start in order.
          command: "npm run rooms -w @felix-canvas/snapshotter",
          cwd: root,
          url: "http://127.0.0.1:8789/api/health",
          env: {
            CANVAS_FELIX_CONTROL_PLANE: "http://127.0.0.1:8443",
            CANVAS_SERVICE_IDP: "http://127.0.0.1:9400",
            CANVAS_FELIX_CA_FILE: `${state}/broker-cert.pem`,
            CANVAS_INVITE_SECRET: "end-to-end-tests-only",
            ...(process.env.CANVAS_FELIX_CLUSTER ? { CANVAS_REPLICAS: "3" } : {}),
          },
          reuseExistingServer: !process.env.CI,
        },
        {
          command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
