$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$sourceRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path $dshHome 'plugins\dsh-file-drop-attachments')).TrimEnd('\')
$profileRoot = Join-Path $dshHome 'profiles\web'
$profilePackage = Join-Path $profileRoot 'package.json'
$profilePatch = Join-Path $profileRoot 'cordis.patch.yml'

New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
if ($sourceRoot -ne $pluginRoot) {
  Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $pluginRoot -Recurse -Force
}

if (-not (Test-Path $profilePackage)) {
  throw "Web profile package.json not found: $profilePackage"
}
if (-not (Test-Path $profilePatch)) {
  throw "Web profile cordis.patch.yml not found: $profilePatch"
}

$package = Get-Content -Raw -LiteralPath $profilePackage | ConvertFrom-Json
if ($null -eq $package.dependencies) {
  $package | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
}
$package.dependencies | Add-Member -MemberType NoteProperty -Name 'dsh-file-drop-attachments-persisted' -Value 'link:..\..\plugins\dsh-file-drop-attachments' -Force
$packageJson = $package | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($profilePackage, $packageJson, [System.Text.UTF8Encoding]::new($false))

$patch = Get-Content -Raw -LiteralPath $profilePatch
if ($patch -notmatch '(?m)^\s*name:\s*dsh-file-drop-attachments-persisted\s*$') {
  $oldRowPattern = '(?m)^(\s*-\s*id:\s*file-drop-attachments\s*\r?\n\s*name:\s*)dsh-file-drop-attachments\s*$'
  $updatedPatch = [regex]::Replace($patch, $oldRowPattern, '${1}dsh-file-drop-attachments-persisted')
  if ($updatedPatch -ne $patch) {
    $patch = $updatedPatch
  } else {
    if (-not $patch.EndsWith("`n")) { $patch += "`r`n" }
    $patch += @"

# File drop attachments: native image previews plus persistent non-image cards.
- insert:
    - id: file-drop-attachments
      name: dsh-file-drop-attachments-persisted
"@
  }
  [System.IO.File]::WriteAllText($profilePatch, $patch, [System.Text.UTF8Encoding]::new($false))
}

Push-Location $profileRoot
try {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  } else {
    Write-Warning 'pnpm was not found. Run pnpm install manually from the web profile.'
  }
} finally {
  Pop-Location
}

Write-Host "Installed dsh-file-drop-attachments-persisted to $pluginRoot"
Write-Host 'Restart DSH Web, or refresh after the profile watcher applies the startup row.'
