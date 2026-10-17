param(
  [string]$Repository = 'https://github.com/cjjchina3088191870-sudo/dsh-email.git',
  [string]$Commit = 'fb7a9cbcace860af06c8d415aa85a8c3b21cd30d'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target = Join-Path $root 'agent\dsh-email'
$profile = Join-Path $root 'agent\dsh-home\profiles\xiaotihu'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required to install the pinned dsh-email plugin.' }
if (-not (Test-Path (Join-Path $target '.git'))) {
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  git clone $Repository $target
}
Push-Location $target
try {
  git fetch --depth 1 origin $Commit
  git checkout --detach $Commit
} finally { Pop-Location }

$sourceFiles = Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.Extension -in @('.js', '.mjs', '.cjs') }
foreach ($sourceFile in $sourceFiles) {
  $text = Get-Content -LiteralPath $sourceFile.FullName -Raw
  $next = $text -replace "import \{ settingsNamespace \} from '@deepseek-ai/dsh-settings'\s*", ""
  $next = $next -replace "settingsNamespace\('dsh-email'\)", "'dsh-email'"
  $configDir = "const EMAIL_CONFIG_DIR = process.env.TINYPELICAN_DATA_DIR`n  || process.env.TINYPELICAN_EMAIL_CONFIG`n  || process.env.DSH_HOME`n  || join(homedir(), '.dsh')"
  $next = $next -replace "const CONFIG_FILE = join\(homedir\(\), '\.dsh', 'dsh-email\.json'\)", "$configDir`nconst CONFIG_FILE = join(EMAIL_CONFIG_DIR, 'dsh-email.json')"
  $next = $next -replace "mkdirSync\(join\(homedir\(\), '\.dsh'\), \{ recursive: true \}\)", "mkdirSync(EMAIL_CONFIG_DIR, { recursive: true })"
  if ($next -ne $text) { Set-Content -LiteralPath $sourceFile.FullName -Value $next -Encoding UTF8 }
}

$manifestPath = Join-Path $profile 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.dependencies) { $manifest | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{}) }
$dependencies = @{}
foreach ($property in $manifest.dependencies.PSObject.Properties) {
  $dependencies[$property.Name] = $property.Value
}
$dependencies['dsh-email'] = 'link:../../../dsh-email'
$manifest.dependencies = [pscustomobject]$dependencies
if (-not $manifest.dsh.profile.bundles) { $manifest.dsh.profile.bundles = @() }
if (-not @($manifest.dsh.profile.bundles).Contains('dsh-email')) { $manifest.dsh.profile.bundles += 'dsh-email' }
$manifestJson = $manifest | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) { pnpm --dir $profile install --lockfile-only --ignore-scripts }
Write-Host "Installed dsh-email at $Commit. Run npm run check and the DSH smoke test before packaging."
