$ErrorActionPreference = 'Stop'

# Offline installer for dsh-file-drop-attachments.
#
# The package declares `dsh.bundle.patch`, so the profile mounts it as a bundle
# layer: one `link:` dependency plus an entry in `dsh.profile.bundles`. A
# hand-written `cordis.patch.yml` insert row mounts the same plugin a second
# time, so this script removes the legacy row instead of writing a new one.

$packageName = 'dsh-file-drop-attachments-persisted'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$sourceRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path $dshHome 'plugins\dsh-file-drop-attachments')).TrimEnd('\')
$profileRoot = Join-Path $dshHome 'profiles\web'
$profilePackage = Join-Path $profileRoot 'package.json'
$profilePatch = Join-Path $profileRoot 'cordis.patch.yml'

New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
if ($sourceRoot -ne $pluginRoot) {
  Get-ChildItem -LiteralPath $sourceRoot -Force |
    Where-Object { $_.Name -ne '.git' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $pluginRoot -Recurse -Force }
}

if (-not (Test-Path $profilePackage)) {
  throw "Web profile package.json not found: $profilePackage"
}
if (-not (Test-Path $profilePatch)) {
  throw "Web profile cordis.patch.yml not found: $profilePatch"
}

# 1) Dependency: the checkout is linked from the profile, not copied into it.
$package = Get-Content -Raw -LiteralPath $profilePackage | ConvertFrom-Json
if ($null -eq $package.dependencies) {
  $package | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
}
$package.dependencies | Add-Member -MemberType NoteProperty -Name $packageName -Value 'link:..\..\plugins\dsh-file-drop-attachments' -Force

# 2) Bundle layer: the same list `dsh plugin add` reconciles from installed packages.
if ($null -eq $package.dsh) {
  $package | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{})
}
if ($null -eq $package.dsh.profile) {
  $package.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{})
}
$bundles = @()
if ($null -ne $package.dsh.profile.bundles) { $bundles = @($package.dsh.profile.bundles) }
if ($bundles -notcontains $packageName) { $bundles = @($bundles) + $packageName }
$package.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force
$packageJson = $package | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($profilePackage, $packageJson, [System.Text.UTF8Encoding]::new($false))

# 3) Drop the legacy hand-written mount row, which the bundle layer replaces.
#    One insert item is the `- insert:` line plus every following indented or
#    blank line, optionally preceded by its own comment line.
$patch = Get-Content -Raw -LiteralPath $profilePatch
$insertBlock = [regex]'(?m)(?:^[ \t]*#[^\r\n]*\r?\n)?^[ \t]*-[ \t]+insert:[ \t]*\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n)|\r?\n)*'
$legacy = @($insertBlock.Matches($patch) | Where-Object {
  $_.Value -match '(?m)^[ \t]*-[ \t]*id:[ \t]*file-drop-attachments[ \t]*$'
})
for ($index = $legacy.Count - 1; $index -ge 0; $index--) {
  $patch = $patch.Remove($legacy[$index].Index, $legacy[$index].Length)
}
if ($legacy.Count -gt 0) {
  [System.IO.File]::WriteAllText($profilePatch, $patch, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Removed $($legacy.Count) legacy cordis.patch.yml mount row(s) for file-drop-attachments."
}

Push-Location $profileRoot
try {
  if (Get-Command dsh -ErrorAction SilentlyContinue) {
    # The official manager runs pnpm and reconciles dsh.profile.bundles.
    & dsh plugin --profile web install
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin install failed with exit code $LASTEXITCODE" }
  } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  } else {
    Write-Warning 'Neither dsh nor pnpm was found. Run pnpm install manually from the web profile.'
  }
} finally {
  Pop-Location
}

Write-Host "Installed $packageName from $pluginRoot"
Write-Host 'It is now a profile bundle: restart DSH Web to pick up the new bundle layer.'
