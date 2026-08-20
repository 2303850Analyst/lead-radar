import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SEARCH_CANARY_PRODUCTION_BUNDLE_URL = new URL(
  "../../dist/server/index.js",
  import.meta.url,
);

async function checksumArtifacts(artifacts) {
  const hash = createHash("sha256");
  for (const [label, url] of artifacts) {
    hash.update(label);
    hash.update("\0");
    hash.update(await readFile(url));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function currentSearchCanaryArtifactFingerprints() {
  const productionBundleSha256 = await checksumArtifacts([
    ["dist/server/index.js", SEARCH_CANARY_PRODUCTION_BUNDLE_URL],
  ]);
  const canaryHarnessSha256 = await checksumArtifacts([
    ["scripts/canary-search-live.mjs", new URL("../canary-search-live.mjs", import.meta.url)],
    ["scripts/lib/search-live-canary.mjs", new URL("./search-live-canary.mjs", import.meta.url)],
    ["scripts/lib/search-canary-profile.mjs", new URL("./search-canary-profile.mjs", import.meta.url)],
    ["scripts/lib/search-canary-artifacts.mjs", new URL(import.meta.url)],
    ["scripts/run-search-live-canary.ps1", new URL("../run-search-live-canary.ps1", import.meta.url)],
    ["scripts/run-with-kimi-secret.ps1", new URL("../run-with-kimi-secret.ps1", import.meta.url)],
    ["package.json", new URL("../../package.json", import.meta.url)],
  ]);
  return { productionBundleSha256, canaryHarnessSha256 };
}
