# parity 데모 (Windows PowerShell 5.1 / PowerShell 7)
#   powershell -ExecutionPolicy Bypass -File scripts\demo.ps1
# 주의: 이름이 guestbook 인 컨테이너를 지우고 다시 만든다.
Set-Location (Split-Path -Parent $PSScriptRoot)

$Image = 'guestbook:1'
$Container = 'guestbook'
$Port = 8080
$Proxy = '127.0.0.1:8081'
$Target = "http://localhost:$Port"
$Record = 'records/session.jsonl'
$Python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Step([string]$Title) { Write-Host "== $Title" -ForegroundColor Cyan }
function Check([string]$What, [int[]]$Ok = @(0)) {
    if ($Ok -notcontains $LASTEXITCODE) {
        Write-Host "$What 실패 (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Step "[1/5] 이미지 빌드 · 컨테이너 실행 ($Image → $Container, :$Port)"
docker build -q -t $Image ../sample-app | Out-Null; Check 'docker build'
if (docker ps -a -q --filter "name=^$Container$") { docker rm -f $Container | Out-Null }
docker run -d --name $Container -p "${Port}:8080" $Image | Out-Null; Check 'docker run'

Step "[2/5] 프록시($Proxy)로 기록하면서 simulate_usage.py 실행"
& $Python -m parity record --target $Target --listen $Proxy --out $Record '--' $Python scripts/simulate_usage.py --base "http://$Proxy"
Check 'record'

Step '[3/5] 노이즈 탐지'
& $Python -m parity noise --record $Record --target $Target --container $Container
Check 'noise'

Step '[4/5] test 실행 → result.json'
& $Python -m parity test --record $Record --target $Target --container $Container --conditions none,restart --out result.json | Out-Null
Check 'test' @(0, 1)   # 1 = 불일치 있음 (정상적인 결과)

Step '[5/5] 결과 요약'
& $Python -m parity summary result.json
