# Anthropic API 키를 .env 의 ANTHROPIC_API_KEY 칸에 넣는다.
#   더블클릭: set-anthropic-key.cmd
#   직접:     powershell -ExecutionPolicy Bypass -File .\set-anthropic-key.ps1
#
# - 입력하는 키는 화면에 보이지 않는다 (별표 입력).
# - 저장하기 전에 Anthropic 에 가벼운 요청(모델 목록)을 보내 키가 살아 있는지 확인한다. 요금은 들지 않는다.
# - .env 는 .gitignore 에 들어 있어 git 에 올라가지 않는다.
param(
  [string]$EnvPath = (Join-Path $PSScriptRoot '.env'),
  [string]$Key,            # 테스트용 — 비우면 입력 창을 띄운다
  [switch]$SkipVerify      # 테스트용 — 키 확인 요청을 건너뛴다
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

if (-not $Key) {
  Write-Host ''
  Write-Host '  Anthropic API 키 입력 (console.anthropic.com → API Keys)' -ForegroundColor Cyan
  Write-Host '  붙여넣기(마우스 오른쪽 클릭 또는 Ctrl+V) 후 Enter. 입력한 글자는 보이지 않습니다.'
  $secure = Read-Host '  키' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$Key = ($Key -replace '\s', '')

if (-not $Key) { Write-Host '  키가 비어 있어 아무것도 바꾸지 않았습니다.' -ForegroundColor Yellow; exit 1 }
if ($Key -notmatch '^sk-ant-[A-Za-z0-9_\-]{20,}$') {
  Write-Host '  sk-ant- 로 시작하는 Anthropic API 키가 아닙니다. 아무것도 바꾸지 않았습니다.' -ForegroundColor Red
  exit 1
}
$masked = 'sk-ant-…' + $Key.Substring($Key.Length - 4)

if (-not $SkipVerify) {
  Write-Host "  키 확인 중 ($masked) ..."
  try {
    $null = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/models?limit=1' -Method Get -TimeoutSec 20 `
      -Headers @{ 'x-api-key' = $Key; 'anthropic-version' = '2023-06-01' }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) { Write-Host '  Anthropic 이 이 키를 거부했습니다 (401). 키를 다시 복사해 주세요. 아무것도 바꾸지 않았습니다.' -ForegroundColor Red; exit 1 }
    if ($code -eq 403) { Write-Host '  키는 맞지만 권한이 없습니다 (403). 콘솔에서 결제·권한을 확인해 주세요. 아무것도 바꾸지 않았습니다.' -ForegroundColor Red; exit 1 }
    Write-Host "  확인 요청이 실패했습니다 ($($_.Exception.Message)). 네트워크 문제일 수 있어 저장은 진행합니다." -ForegroundColor Yellow
  }
}

# .env 가 없으면 .env.example 을 복사해서 만든다
if (-not (Test-Path $EnvPath)) {
  $example = Join-Path (Split-Path $EnvPath) '.env.example'
  if (Test-Path $example) { Copy-Item $example $EnvPath } else { Write-Utf8NoBom $EnvPath '' }
}

$lines = [Collections.Generic.List[string]]([IO.File]::ReadAllLines($EnvPath))
$idx = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*ANTHROPIC_API_KEY\s*=') { $idx = $i; break } }
$had = $idx -ge 0 -and ($lines[$idx] -replace '^\s*ANTHROPIC_API_KEY\s*=\s*', '').Trim() -ne ''
if ($idx -ge 0) { $lines[$idx] = "ANTHROPIC_API_KEY=$Key" } else { $lines.Add("ANTHROPIC_API_KEY=$Key") }
Write-Utf8NoBom $EnvPath (($lines -join "`r`n") + "`r`n")
$Key = $null

Write-Host ''
Write-Host ("  저장했습니다: {0}  ({1})" -f $EnvPath, $masked) -ForegroundColor Green
if ($had) { Write-Host '  기존 키를 새 키로 바꿨습니다.' }
Write-Host '  Conduit 서버가 켜져 있으면 다시 시작해야 새 키를 읽습니다.'
exit 0
