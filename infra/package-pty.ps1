# Build a checksummed release locally. Does not deploy, upload or read secrets.
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
$sha = (git rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve release commit' }
if (git status --porcelain) { throw 'Commit and validate release changes before packaging' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a fresh output directory' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$release = Join-Path $OutputDirectory 'release'
New-Item -ItemType Directory -Path (Join-Path $release 'api') -Force | Out-Null
$settings = @{}
foreach ($line in Get-Content infra/deploy/production.env) {
  if ($line -match '^([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
}
npm run build -w '@pineagent/api'
if ($LASTEXITCODE -ne 0) { throw 'API build failed' }
Copy-Item services/api/dist/*.mjs,services/api/dist/*.map -Destination (Join-Path $release 'api')
$env:VITE_API_URL=$settings.PUBLIC_URL
$env:VITE_AUTH0_DOMAIN=$settings.AUTH0_DOMAIN
$env:VITE_AUTH0_CLIENT_ID=$settings.AUTH0_SPA_CLIENT_ID
$env:VITE_AUTH0_AUDIENCE=$settings.AUTH0_AUDIENCE
$env:VITE_REPOS=$settings.ALLOWED_REPOS
Push-Location apps/web
try { npx vite build --mode production --outDir (Join-Path $release 'web'); if ($LASTEXITCODE -ne 0) { throw 'Web build failed' } }
finally { Pop-Location }
$keys = @('AUTH0_DOMAIN','AUTH0_AUDIENCE','AUTH0_M2M_CLIENT_ID','AUTH0_M2M_KEY_FILE','WORKSPACES_ROOT','ALLOWED_ORIGINS','ALLOWED_REPOS','AWS_REGION','DYNAMODB_LOCKS_TABLE','DYNAMODB_FILES_TABLE')
$lines = @($keys | ForEach-Object { "$_=$($settings[$_])" }) + @("RELEASE_SHA=$sha",'HARNESS_ENABLED=true','SANDBOX_SOCKET=/run/pineagent-sandbox/control.sock','TERMINAL_RELAY_ROOT=/run/pineagent-terminals','ROUTER_SECRET_REGION=us-east-1','DECISIONS_SECRET_ID=OPENAI_API_KEY','JEV_SECRET_ID=JEV_API_KEY')
[IO.File]::WriteAllText((Join-Path $release 'api.env'), ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
Copy-Item infra/sandbox/pineagent-sandbox.service -Destination $release
docker build --target validation -t pineagent-cli-validation:pty apps/cli
if ($LASTEXITCODE -ne 0) { throw 'Sandbox image build failed' }
$imageId = (docker image inspect pineagent-cli-validation:pty --format '{{.Id}}').Trim()
docker save -o (Join-Path $OutputDirectory "$sha-image.tar") pineagent-cli-validation:pty
if ($LASTEXITCODE -ne 0) { throw 'Sandbox image export failed' }
tar -czf (Join-Path $OutputDirectory "$sha.tgz") -C $release api web api.env pineagent-sandbox.service
if ($LASTEXITCODE -ne 0) { throw 'Release archive failed' }
$result = @{ sha=$sha; imageId=$imageId; release=(Join-Path $OutputDirectory "$sha.tgz"); image=(Join-Path $OutputDirectory "$sha-image.tar"); releaseSha256=(Get-FileHash (Join-Path $OutputDirectory "$sha.tgz") -Algorithm SHA256).Hash.ToLower(); imageSha256=(Get-FileHash (Join-Path $OutputDirectory "$sha-image.tar") -Algorithm SHA256).Hash.ToLower() }
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json')
$result | ConvertTo-Json
