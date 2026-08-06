# Edge Function MCP deploy용 JSON 페이로드 생성
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('submit-reservation', 'my-reservations', 'check-booking-submit-allowed')]
  [string]$FunctionName
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Read-Utf8([string]$path) {
  Get-Content -LiteralPath $path -Raw -Encoding UTF8
}

$payload = $null
switch ($FunctionName) {
  'submit-reservation' {
    $payload = @{
      name            = 'submit-reservation'
      entrypoint_path = 'index.ts'
      verify_jwt      = $false
      files           = @(
        @{ name = 'index.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\submit-reservation\index.ts') }
        @{ name = '../_shared/booking_deadline.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\_shared\booking_deadline.ts') }
      )
    }
  }
  'my-reservations' {
    $payload = @{
      name            = 'my-reservations'
      entrypoint_path = 'supabase/functions/my-reservations/index.ts'
      verify_jwt      = $false
      files           = @(
        @{ name = 'supabase/functions/my-reservations/index.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\my-reservations\index.ts') }
        @{ name = 'supabase/functions/_shared/booking_deadline.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\_shared\booking_deadline.ts') }
      )
    }
  }
  'check-booking-submit-allowed' {
    $payload = @{
      name            = 'check-booking-submit-allowed'
      entrypoint_path = 'index.ts'
      verify_jwt      = $false
      files           = @(
        @{ name = 'index.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\check-booking-submit-allowed\index.ts') }
        @{ name = '../_shared/booking_submit_block_ip.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\_shared\booking_submit_block_ip.ts') }
        @{ name = '../_shared/admin_source_ip.ts'; content = Read-Utf8 (Join-Path $root 'supabase\functions\_shared\admin_source_ip.ts') }
      )
    }
  }
}

$out = Join-Path $root ".deploy-mcp-$FunctionName.json"
$payload | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $out -Encoding UTF8
Write-Output $out
