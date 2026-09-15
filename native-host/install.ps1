# Notely Native Messaging Host — Windows installer
#
# Usage:
#   .\install.ps1 -ExtensionId <your-chrome-extension-id>
#
# Find your extension ID in chrome://extensions (enable Developer mode).
# Example:
#   .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'

$dir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeBat = Join-Path $dir 'bridge.bat'
$manifestDst = "$env:APPDATA\notely\com.notely.bridge.json"

# Locate node.exe
$nodeCmd  = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCmd) { $nodeCmd.Source } else { $null }
if (-not $nodePath) {
  Write-Error "node.exe not found on PATH. Install Node.js first."
  exit 1
}

# Patch bridge.bat with the real node path
$batContent = Get-Content $bridgeBat -Raw
$batContent = $batContent -replace '"NODE_EXE_PLACEHOLDER"', "`"$nodePath`""
Set-Content $bridgeBat -Value $batContent -Encoding ASCII
Write-Host "Patched bridge.bat → node: $nodePath"

# Write the Native Messaging host manifest to APPDATA
New-Item -ItemType Directory -Force -Path (Split-Path $manifestDst) | Out-Null

$manifest = '{
  "name": "com.notely.bridge",
  "description": "Notely Native Messaging Bridge",
  "path": "' + $bridgeBat.Replace('\', '\\') + '",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://' + $ExtensionId + '/"]
}'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($manifestDst, $manifest, $utf8NoBom)
Write-Host "Manifest written → $manifestDst"

# Register in Chrome's Native Messaging registry (current user)
$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.notely.bridge'
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name '(Default)' -Value $manifestDst
Write-Host "Registry key set → $regKey"

Write-Host ""
Write-Host "Done. Restart Chrome, then reload the Notely extension."
Write-Host "Start the MCP relay first:  cd mcp-server && node index.js"
