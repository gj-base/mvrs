# Edge Functions: submit-reservation, check-booking-submit-allowed 배포
# 1) Supabase > Account > Access Tokens 에서 Personal Access Token 생성
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
  Write-Host "Supabase CLI가 없습니다. .\scripts\setup-supabase-cli.ps1 후 다시 실행하세요."
  exit 1
}

$configPath = Join-Path $root "config.js"
if (-not (Test-Path $configPath)) { throw "config.js 없음" }
$cfg = Get-Content $configPath -Raw -Encoding UTF8
$m = [regex]::Match($cfg, "https://([a-z0-9]+)\.supabase\.co")
if (-not $m.Success) { throw "config.js 에서 project ref 파싱 실패" }
$projectRef = $m.Groups[1].Value
Write-Host "Supabase: $supabaseExe"
Write-Host "project-ref: $projectRef"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host ""
  Write-Host "[필요] 환경 변수 SUPABASE_ACCESS_TOKEN 이 없습니다."
  Write-Host '  $env:SUPABASE_ACCESS_TOKEN="sbp_여기에붙여넣기"'
  Write-Host "  .\scripts\deploy-booking-edge-functions.ps1"
  exit 1
}

& $supabaseExe functions deploy submit-reservation --no-verify-jwt --project-ref $projectRef
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "배포 완료: submit-reservation"

& $supabaseExe functions deploy check-booking-submit-allowed --no-verify-jwt --project-ref $projectRef
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "배포 완료: check-booking-submit-allowed"
