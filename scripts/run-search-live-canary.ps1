[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$localEnv = Join-Path $projectRoot ".env.local"
if (Test-Path -LiteralPath $localEnv -PathType Leaf) {
  $hasKimiSecret = Get-Content -LiteralPath $localEnv |
    Where-Object {
      $_ -match "^\s*(KIMI_API_KEY|MOONSHOT_API_KEY)\s*=\s*[^\s#]+"
    } |
    Select-Object -First 1
  if ($hasKimiSecret) {
    throw "Move the Kimi key out of .env.local and into ~/.sa-trainer-secrets/kimi.env before running the canary."
  }
}

$previousKimiKey = $env:KIMI_API_KEY
$previousMoonshotKey = $env:MOONSHOT_API_KEY
$previousSigningSecret = $env:SEARCH_PLAN_SIGNING_SECRET
try {
  Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:MOONSHOT_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:SEARCH_PLAN_SIGNING_SECRET -ErrorAction SilentlyContinue
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  if ($null -ne $previousKimiKey) { $env:KIMI_API_KEY = $previousKimiKey }
  if ($null -ne $previousMoonshotKey) { $env:MOONSHOT_API_KEY = $previousMoonshotKey }
  if ($null -ne $previousSigningSecret) {
    $env:SEARCH_PLAN_SIGNING_SECRET = $previousSigningSecret
  }
}

& (Join-Path $PSScriptRoot "run-with-kimi-secret.ps1") `
  -NpmScript "canary:search:live:run"
exit $LASTEXITCODE
