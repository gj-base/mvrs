# Edge Function admin-manage-public-settings 배포
# 1) (최초 1회) Access Token: 대시보드 > Account > Access Tokens > Generate new token
# 2) PowerShell:  $env:SUPABASE_ACCESS_TOKEN="sbp_...."
# 3) 이 스크립트 실행

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$exeCandidates = @(
  (Join-Path $root ".tools\supabase-cli\supabase.exe"),
  "supabase"
)
$supabaseExe = $null
foreach ($c in $exeCandidates) {
  if ($c -eq "supabase") {
    $cmd = Get-Command supabase -ErrorAction SilentlyContinue
    if ($cmd) { $supabaseExe = $cmd.Source; break }
  } elseif (Test-Path $c) { $supabaseExe = $c; break }
}
if (-not $supabaseExe) {
  Write-Host "Supabase CLI가 없습니다. 다음으로 설치한 뒤 다시 실행하세요:"
  Write-Host "  .\scripts\setup-supabase-cli.ps1"
  exit 1
}

$configPath = Join-Path $root "config.js"
if (-not (Test-Path $configPath)) { throw "config.js 없음" }
$cfg = Get-Content $configPath -Raw -Encoding UTF8
$m = [regex]::Match($cfg, "https://([a-z0-9]+)\.supabase\.co")
if (-not $m.Success) { throw "config.js 에서 SUPABASE_URL(project ref) 파싱 실패" }
$projectRef = $m.Groups[1].Value
Write-Host "Supabase: $supabaseExe"
Write-Host "project-ref: $projectRef"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host ""
  Write-Host "[필요] 환경 변수 SUPABASE_ACCESS_TOKEN 이 없습니다."
  Write-Host "Supabase 대시보드 > Account > Access Tokens 에서 토큰 생성 후:"
  Write-Host '  $env:SUPABASE_ACCESS_TOKEN="sbp_여기에붙여넣기"'
  Write-Host "  .\scripts\deploy-admin-manage-public-settings.ps1"
  exit 1
}

& $supabaseExe functions deploy admin-manage-public-settings --no-verify-jwt --project-ref $projectRef
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "배포 완료: admin-manage-public-settings"
