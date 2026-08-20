import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Kimi secret wrapper ignores inherited credential precedence and restores both variables",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "lead-radar-kimi-wrapper-"));
    const secretFile = join(directory, "kimi.env");
    const captureScript = join(directory, "capture.mjs");
    const captureFile = join(directory, "runtime.json");
    const afterFile = join(directory, "after.json");
    const npmShim = join(directory, "npm.cmd");
    const wrapper = resolve("scripts/run-with-kimi-secret.ps1");
    try {
      await writeFile(secretFile, "KIMI_API_KEY=file-test-key\n", "utf8");
      await writeFile(
        captureScript,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.TEST_CAPTURE_FILE, JSON.stringify({",
          "  kimi: process.env.KIMI_API_KEY ?? null,",
          "  moonshot: process.env.MOONSHOT_API_KEY ?? null,",
          "}));",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        npmShim,
        '@echo off\r\nnode "%TEST_CAPTURE_SCRIPT%"\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );

      const command = [
        "$env:KIMI_API_KEY='parent-kimi'",
        "$env:MOONSHOT_API_KEY='parent-moonshot'",
        `& '${wrapper.replaceAll("'", "''")}' -NpmScript 'noop'`,
        "$after = @{ kimi = $env:KIMI_API_KEY; moonshot = $env:MOONSHOT_API_KEY } | ConvertTo-Json -Compress",
        "[System.IO.File]::WriteAllText($env:TEST_AFTER_FILE, $after)",
      ].join("; ");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${directory};${process.env.PATH ?? ""}`,
            KIMI_SECRET_FILE: secretFile,
            TEST_CAPTURE_SCRIPT: captureScript,
            TEST_CAPTURE_FILE: captureFile,
            TEST_AFTER_FILE: afterFile,
          },
          timeout: 30_000,
        },
      );

      assert.deepEqual(JSON.parse(await readFile(captureFile, "utf8")), {
        kimi: "file-test-key",
        moonshot: null,
      });
      assert.deepEqual(JSON.parse(await readFile(afterFile, "utf8")), {
        kimi: "parent-kimi",
        moonshot: "parent-moonshot",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Kimi secret wrapper restores credentials when the dist secret scan fails",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "lead-radar-kimi-scan-"));
    const secretValue = `forced-dist-secret-${process.pid}-${Date.now()}`;
    const kimiValue = `separate-kimi-secret-${process.pid}-${Date.now()}`;
    const secretFile = join(directory, "kimi.env");
    const afterFile = join(directory, "after.json");
    const distDirectory = resolve("dist");
    const distSentinel = join(
      distDirectory,
      `.canary-secret-scan-${process.pid}.txt`,
    );
    const wrapper = resolve("scripts/run-with-kimi-secret.ps1");
    try {
      await mkdir(distDirectory, { recursive: true });
      await writeFile(secretFile, `KIMI_API_KEY=${kimiValue}\n`, "utf8");
      await writeFile(distSentinel, secretValue, "utf8");
      const command = [
        "$env:KIMI_API_KEY='parent-kimi'",
        "$env:MOONSHOT_API_KEY='parent-moonshot'",
        `$env:GEOAPIFY_API_KEY='${secretValue}'`,
        "$caught=$false",
        `try { & '${wrapper.replaceAll("'", "''")}' -NpmScript 'noop' } catch { $caught=$true }`,
        "$after = @{ caught = $caught; kimi = $env:KIMI_API_KEY; moonshot = $env:MOONSHOT_API_KEY } | ConvertTo-Json -Compress",
        "[System.IO.File]::WriteAllText($env:TEST_AFTER_FILE, $after)",
      ].join("; ");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            KIMI_SECRET_FILE: secretFile,
            TEST_AFTER_FILE: afterFile,
          },
          timeout: 30_000,
        },
      );
      assert.deepEqual(JSON.parse(await readFile(afterFile, "utf8")), {
        caught: true,
        kimi: "parent-kimi",
        moonshot: "parent-moonshot",
      });
    } finally {
      await rm(distSentinel, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
