[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$NpmScript = "dev",

  [Parameter(Mandatory = $false)]
  [string[]]$NpmArguments = @()
)

$ErrorActionPreference = "Stop"

$secretFile = if ($env:KIMI_SECRET_FILE) {
  $env:KIMI_SECRET_FILE
} else {
  Join-Path $env:USERPROFILE ".sa-trainer-secrets\kimi.env"
}

if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
  throw "Kimi secret file was not found. Set KIMI_SECRET_FILE or create ~/.sa-trainer-secrets/kimi.env."
}

$secretLine = Get-Content -LiteralPath $secretFile |
  Where-Object { $_ -match "^\s*(KIMI_API_KEY|MOONSHOT_API_KEY)\s*=" } |
  Select-Object -First 1

if (-not $secretLine) {
  throw "KIMI_API_KEY or MOONSHOT_API_KEY is missing from the secret file."
}

$secretParts = $secretLine -split "=", 2
$secretVariable = $secretParts[0].Trim()
$apiKey = $secretParts[1].Trim().Trim('"').Trim("'")
if (-not $apiKey) {
  throw "The Kimi API key in the secret file is empty."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$localEnv = Join-Path $projectRoot ".env.local"
$geoapifyKey = $env:GEOAPIFY_API_KEY
if (-not $geoapifyKey -and (Test-Path -LiteralPath $localEnv -PathType Leaf)) {
  $geoapifyLine = Get-Content -LiteralPath $localEnv |
    Where-Object { $_ -match "^\s*GEOAPIFY_API_KEY\s*=" } |
    Select-Object -First 1
  if ($geoapifyLine) {
    $geoapifyKey = ($geoapifyLine -split "=", 2)[1].Trim().Trim('"').Trim("'")
  }
}
$secretsToScan = @($apiKey, $geoapifyKey) |
  Where-Object { $_ } |
  Select-Object -Unique

$previousKimiKey = $env:KIMI_API_KEY
$previousMoonshotKey = $env:MOONSHOT_API_KEY
$previousSigningSecret = $env:SEARCH_PLAN_SIGNING_SECRET
$previousPlannerMode = $env:QUERY_INTELLIGENCE_MODE
try {
  Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:MOONSHOT_API_KEY -ErrorAction SilentlyContinue
  if ($secretVariable -eq "MOONSHOT_API_KEY") {
    $env:MOONSHOT_API_KEY = $apiKey
  } else {
    $env:KIMI_API_KEY = $apiKey
  }
  $env:QUERY_INTELLIGENCE_MODE = if ($previousPlannerMode) {
    $previousPlannerMode
  } else {
    "kimi"
  }
  if (-not $env:SEARCH_PLAN_SIGNING_SECRET) {
    $randomBytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $random.GetBytes($randomBytes)
      $env:SEARCH_PLAN_SIGNING_SECRET = [Convert]::ToBase64String($randomBytes)
    } finally {
      $random.Dispose()
      [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    }
  }

  $distDirectory = Join-Path $projectRoot "dist"
  if (Test-Path -LiteralPath $distDirectory -PathType Container) {
    $secretFound = $false
    foreach ($file in Get-ChildItem -LiteralPath $distDirectory -Recurse -File) {
      foreach ($secret in $secretsToScan) {
        if (Select-String -LiteralPath $file.FullName -SimpleMatch -Pattern $secret -Quiet) {
          $secretFound = $true
          break
        }
      }
      if ($secretFound) { break }
    }
    if ($secretFound) {
      throw "The built dist contains a server-side API key; refusing to start the process."
    }
  }

  & npm run $NpmScript -- @NpmArguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  if ($null -eq $previousKimiKey) {
    Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:KIMI_API_KEY = $previousKimiKey
  }
  if ($null -eq $previousMoonshotKey) {
    Remove-Item Env:MOONSHOT_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:MOONSHOT_API_KEY = $previousMoonshotKey
  }
  if ($null -eq $previousSigningSecret) {
    Remove-Item Env:SEARCH_PLAN_SIGNING_SECRET -ErrorAction SilentlyContinue
  } else {
    $env:SEARCH_PLAN_SIGNING_SECRET = $previousSigningSecret
  }
  if ($null -eq $previousPlannerMode) {
    Remove-Item Env:QUERY_INTELLIGENCE_MODE -ErrorAction SilentlyContinue
  } else {
    $env:QUERY_INTELLIGENCE_MODE = $previousPlannerMode
  }
  $apiKey = $null
  $secretLine = $null
  $secretParts = $null
  $geoapifyKey = $null
  $geoapifyLine = $null
  $secretsToScan = $null
}
