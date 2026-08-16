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

$apiKey = ($secretLine -split "=", 2)[1].Trim().Trim('"').Trim("'")
if (-not $apiKey) {
  throw "The Kimi API key in the secret file is empty."
}

$previousKey = $env:KIMI_API_KEY
$previousSigningSecret = $env:SEARCH_PLAN_SIGNING_SECRET
$previousPlannerMode = $env:QUERY_INTELLIGENCE_MODE
$env:KIMI_API_KEY = $apiKey
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

try {
  & npm run $NpmScript -- @NpmArguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  if ($null -eq $previousKey) {
    Remove-Item Env:KIMI_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:KIMI_API_KEY = $previousKey
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
}
