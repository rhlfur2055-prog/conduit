# Conduit 실행 — 백엔드(8787) + 프론트엔드(5173) 함께 기동
# 이 PC는 Node.js가 fnm으로 설치되어 있어, 스크립트가 환경을 잡아줍니다.

fnm env --shell power-shell | Out-String | Invoke-Expression

# 백엔드를 새 창에서 실행
Start-Process powershell -ArgumentList '-NoExit', '-Command', `
  "fnm env --shell power-shell | Out-String | Invoke-Expression; Set-Location '$PSScriptRoot\server'; Write-Host 'Conduit 백엔드 (8787)' -ForegroundColor Cyan; npm start"

Start-Sleep -Seconds 1

# 프론트엔드는 현재 창에서 실행
Set-Location $PSScriptRoot
Write-Host "Conduit 프론트엔드 → http://localhost:5173" -ForegroundColor Green
Write-Host "실제 Claude 호출을 켜려면: 백엔드 창을 닫고 `$env:ANTHROPIC_API_KEY='sk-...' 설정 후 다시 실행" -ForegroundColor DarkGray
npm run dev
