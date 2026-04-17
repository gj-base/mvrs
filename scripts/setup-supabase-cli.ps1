# Supabase CLI Windows 바이너리를 프로젝트 .tools/supabase-cli 에 설치 (GitHub 릴리스)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root ".tools\supabase-cli"
$exe = Join-Path $tools "supabase.exe"
if (Test-Path $exe) {
  Write-Host "이미 설치됨: $exe"
  & $exe --version
  exit 0
}
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/supabase/cli/releases/latest" -Headers @{ "User-Agent" = "setup-supabase-cli" }
$tag = $rel.tag_name
$asset = $rel.assets | Where-Object { $_.name -eq "supabase_windows_amd64.tar.gz" } | Select-Object -First 1
if (-not $asset) { throw "supabase_windows_amd64.tar.gz 를 찾을 수 없습니다." }
$url = $asset.browser_download_url
$tgz = Join-Path $tools "supabase_windows_amd64.tar.gz"
Write-Host "다운로드: $url"
Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing
tar -xzf $tgz -C $tools
Remove-Item $tgz -Force
& $exe --version
Write-Host "완료: $exe"
