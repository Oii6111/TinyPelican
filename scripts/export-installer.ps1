param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$source = Get-Item -LiteralPath $InstallerPath
if ($source.PSIsContainer -or $source.Extension -ne '.exe') { throw 'Expected an installer executable.' }
if (-not $OutputDirectory) {
  $shellFolders = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
  $downloads = $shellFolders.'{374DE290-123F-4565-9164-39C4925E467B}'
  if (-not $downloads) { $downloads = Join-Path $env:USERPROFILE 'Downloads' }
  $OutputDirectory = Join-Path ([Environment]::ExpandEnvironmentVariables($downloads)) 'TinyPelican'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$destination = Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path $source.Name
if ($destination -eq $source.FullName) { throw 'Export directory must differ from the build directory.' }
$temporary = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
try {
  $inputStream = [IO.File]::OpenRead($source.FullName)
  try {
    $outputStream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
  } finally { $inputStream.Dispose() }
  $sourceHash = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash
  if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $sourceHash) {
    throw 'Exported installer checksum mismatch.'
  }
  Move-Item -LiteralPath $temporary -Destination $destination -Force
  ($sourceHash.ToLowerInvariant() + '  ' + $source.Name) | Set-Content -LiteralPath ($destination + '.sha256') -Encoding ascii
  Write-Output $destination
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
