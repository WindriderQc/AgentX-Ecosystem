$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$envFile = Join-Path $root 'config\agentx.env'
$compose = @('--project-name', 'agentx-ecosystem', '--env-file', $envFile, '-f', 'docker-compose.yml')
$ollamaCompose = $compose + @('-f', 'docker-compose.ollama.yml')
$agentXHealthResponseLimitBytes = 64KB
$agentXOllamaVersionResponseLimitBytes = 16KB

function Invoke-AgentXBoundedHttpGet {
    param(
        [Parameter(Mandatory = $true)] [Uri] $Uri,
        [Parameter(Mandatory = $true)] [ValidateRange(1, 60)] [int] $TimeoutSec,
        [Parameter(Mandatory = $true)] [ValidateRange(1, 1048576)] [int] $MaximumResponseBytes,
        [Parameter(Mandatory = $true)] [ValidateRange(0, 0)] [int] $MaximumRedirection
    )

    if ($Uri.Scheme -ne [Uri]::UriSchemeHttp -or -not $Uri.IsLoopback) {
        throw 'Launcher HTTP checks are restricted to unencrypted loopback endpoints.'
    }

    if (-not [Type]::GetType('System.Net.Http.HttpClient, System.Net.Http', $false)) {
        Add-Type -AssemblyName System.Net.Http
    }

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $handler.MaxResponseHeadersLength = 16
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Uri)
    $cancellation = New-Object System.Threading.CancellationTokenSource
    $cancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))

    try {
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $cancellation.Token
        ).GetAwaiter().GetResult()
        try {
            $statusCode = [int] $response.StatusCode
            if ($statusCode -ge 300 -and $statusCode -lt 400) {
                throw "Launcher HTTP checks reject redirects (HTTP $statusCode)."
            }
            if (-not $response.IsSuccessStatusCode) {
                throw "Launcher HTTP check returned HTTP $statusCode."
            }

            $declaredLength = $response.Content.Headers.ContentLength
            if ($null -ne $declaredLength -and [long] $declaredLength -gt $MaximumResponseBytes) {
                throw "Launcher HTTP response exceeded the $MaximumResponseBytes-byte limit."
            }

            $responseStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            try {
                $body = New-Object System.IO.MemoryStream
                try {
                    $readBuffer = New-Object byte[] ([Math]::Min(8192, $MaximumResponseBytes + 1))
                    while ($true) {
                        $remainingWithSentinel = ($MaximumResponseBytes - [int] $body.Length) + 1
                        $readLength = [Math]::Min($readBuffer.Length, $remainingWithSentinel)
                        $read = $responseStream.ReadAsync(
                            $readBuffer,
                            0,
                            $readLength,
                            $cancellation.Token
                        ).GetAwaiter().GetResult()
                        if ($read -eq 0) { break }
                        if (($body.Length + $read) -gt $MaximumResponseBytes) {
                            throw "Launcher HTTP response exceeded the $MaximumResponseBytes-byte limit."
                        }
                        $body.Write($readBuffer, 0, $read)
                    }

                    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
                    [PSCustomObject]@{
                        StatusCode = $statusCode
                        Content = $utf8.GetString($body.ToArray())
                    }
                }
                finally {
                    $body.Dispose()
                }
            }
            finally {
                $responseStream.Dispose()
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $cancellation.Dispose()
        $request.Dispose()
        $client.Dispose()
    }
}

function Invoke-AgentXBoundedWebRequest {
    param(
        [switch] $UseBasicParsing,
        [Parameter(Mandatory = $true)] [Uri] $Uri,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec,
        [Parameter(Mandatory = $true)] [int] $MaximumResponseBytes,
        [Parameter(Mandatory = $true)] [int] $MaximumRedirection
    )

    Invoke-AgentXBoundedHttpGet `
        -Uri $Uri `
        -TimeoutSec $TimeoutSec `
        -MaximumResponseBytes $MaximumResponseBytes `
        -MaximumRedirection $MaximumRedirection
}

function Invoke-AgentXBoundedRestMethod {
    param(
        [Parameter(Mandatory = $true)] [Uri] $Uri,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec,
        [Parameter(Mandatory = $true)] [int] $MaximumResponseBytes,
        [Parameter(Mandatory = $true)] [int] $MaximumRedirection
    )

    $response = Invoke-AgentXBoundedHttpGet @PSBoundParameters
    $response.Content | ConvertFrom-Json
}

function Assert-DockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine('Docker was not found on PATH. Install Docker Desktop, then reopen PowerShell.')
        exit 3
    }

    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('Docker Compose v2 is unavailable. Install or update Docker Desktop.')
        exit 3
    }

    $composeUpHelp = (& docker compose up --help 2>&1) -join "`n"
    if ($composeUpHelp -notmatch '--wait' -or $composeUpHelp -notmatch '--wait-timeout') {
        [Console]::Error.WriteLine('Docker Compose is too old for health-aware startup. Update Docker Desktop or the Compose v2 plugin.')
        exit 3
    }

    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('Docker is installed, but its engine is not reachable. Start Docker Desktop and retry.')
        exit 3
    }
}

function Ensure-BenchmarkToken {
    if ($env:AGENTX_BENCHMARK_TOKEN) { return }

    foreach ($container in @('agentx-ecosystem-core', 'agentx-ecosystem-benchmark')) {
        $current = & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $container 2>$null |
            Where-Object { $_ -like 'AGENTX_BENCHMARK_TOKEN=*' } |
            Select-Object -First 1
        if ($current -and $current.Length -gt 'AGENTX_BENCHMARK_TOKEN='.Length) {
            $env:AGENTX_BENCHMARK_TOKEN = $current.Substring('AGENTX_BENCHMARK_TOKEN='.Length)
            return
        }
    }

    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $env:AGENTX_BENCHMARK_TOKEN = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Ensure-RecoveryToken {
    if ($env:AGENTX_RECOVERY_TOKEN) { return }

    foreach ($container in @('agentx-ecosystem-core', 'agentx-ecosystem-rag')) {
        $current = & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $container 2>$null |
            Where-Object { $_ -like 'AGENTX_RECOVERY_TOKEN=*' } |
            Select-Object -First 1
        if ($current -and $current.Length -gt 'AGENTX_RECOVERY_TOKEN='.Length) {
            $env:AGENTX_RECOVERY_TOKEN = $current.Substring('AGENTX_RECOVERY_TOKEN='.Length)
            return
        }
    }

    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $env:AGENTX_RECOVERY_TOKEN = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Show-ProductHealth {
    $checks = @(
        @{ Label = 'MongoDB'; Container = 'agentx-ecosystem-mongo'; Health = $true },
        @{ Label = 'Qdrant'; Container = 'agentx-ecosystem-qdrant'; Health = $false },
        @{ Label = 'Core'; Container = 'agentx-ecosystem-core'; Health = $true },
        @{ Label = 'Benchmark'; Container = 'agentx-ecosystem-benchmark'; Health = $true },
        @{ Label = 'RAG'; Container = 'agentx-ecosystem-rag'; Health = $true }
    )
    $failed = $false

    foreach ($check in $checks) {
        $state = & docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' $check.Container 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $state) {
            Write-Host ("{0}: not created" -f $check.Label)
            $failed = $true
            continue
        }

        $parts = $state.Trim().Split('|')
        $runtime = $parts[0]
        $health = if ($parts.Count -gt 1) { $parts[1] } else { '' }
        $display = if ($health) { "$runtime/$health" } else { $runtime }
        Write-Host ("{0}: {1}" -f $check.Label, $display)

        if ($runtime -ne 'running' -or ($check.Health -and $health -ne 'healthy')) {
            $failed = $true
        }
    }

    if ($failed) {
        [Console]::Error.WriteLine('Agent X is not healthy yet. Run ''.\agentx.ps1 status'' and ''.\agentx.ps1 logs core'' for details.')
        return $false
    }

    Write-Host 'Product services are healthy. Ollama and models remain optional.'
    return $true
}

function Wait-PublishedProductEndpoints {
    $ports = @(
        $(if ($env:CORE_PORT) { $env:CORE_PORT } else { '3180' }),
        $(if ($env:BENCHMARK_PORT) { $env:BENCHMARK_PORT } else { '3181' }),
        $(if ($env:RAG_PORT) { $env:RAG_PORT } else { '3182' })
    )
    $deadline = [DateTime]::UtcNow.AddSeconds(30)

    while ([DateTime]::UtcNow -lt $deadline) {
        $ready = $true
        foreach ($port in $ports) {
            try {
                $response = Invoke-AgentXBoundedWebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 -MaximumResponseBytes $agentXHealthResponseLimitBytes -MaximumRedirection 0
                if ($response.StatusCode -ne 200) { $ready = $false }
            }
            catch {
                $ready = $false
            }
        }
        if ($ready) { return $true }
        Start-Sleep -Milliseconds 500
    }

    [Console]::Error.WriteLine('Containers are healthy, but the loopback-published product endpoints did not become reachable within 30 seconds.')
    return $false
}

function Show-Usage {
    @"
Agent X Ecosystem

Usage: .\agentx.ps1 <command> [args...]

Commands:
  doctor                Check Docker CLI, Compose, and engine availability
  up                    Start the selected product profile (demo by default) and wait for health
  health                Verify the five required product containers
  down                  Stop product and Docker Ollama; preserve volumes
  status                Show product service status
  logs [service]        Follow logs; defaults to core
  rebuild [service]     Rebuild images, then start the requested services
  ollama-doctor         Detect native Ollama; never install or download
  ollama-up             Start the opt-in isolated Docker Ollama stack
  ollama-status         Show Docker Ollama status and installed models
  ollama-pull <model>   Explicitly download one model into its named volume
  ollama-down           Stop the Ollama-backed stack; preserve volumes
  reset                 Delete containers, data volumes, and recovery archives

Open http://127.0.0.1:3180/ after startup.
"@
}

$cmd = if ($args.Count -gt 0) { $args[0] } else { '' }
$rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() })

switch ($cmd) {
    'doctor' {
        Assert-DockerReady
        Write-Output 'Docker CLI, Compose, and engine are ready.'
    }
    'up' {
        Assert-DockerReady
        Ensure-BenchmarkToken
        Ensure-RecoveryToken
        & docker compose @compose up -d --wait --wait-timeout 180 @rest mongo qdrant core benchmark rag
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('Startup did not become healthy within 180 seconds. Run ''.\agentx.ps1 status'' and ''.\agentx.ps1 logs core''.')
            exit $LASTEXITCODE
        }
        if (-not (Wait-PublishedProductEndpoints)) { exit 1 }
        $corePort = if ($env:CORE_PORT) { $env:CORE_PORT } else { '3180' }
        Write-Output "Agent X started: http://127.0.0.1:$corePort/"
    }
    'health' {
        Assert-DockerReady
        if (-not (Show-ProductHealth)) { exit 1 }
    }
    'down' {
        Assert-DockerReady
        & docker compose @ollamaCompose --profile ollama down @rest
    }
    { $_ -in 'status', 'ps' } {
        Assert-DockerReady
        & docker compose @ollamaCompose --profile ollama ps
    }
    'logs' {
        Assert-DockerReady
        $service = if ($rest.Count -gt 0) { $rest[0] } else { 'core' }
        & docker compose @ollamaCompose --profile ollama logs -f --tail=200 $service
    }
    'rebuild' {
        Assert-DockerReady
        Ensure-BenchmarkToken
        Ensure-RecoveryToken
        & docker compose @compose build --no-cache @rest
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & docker compose @compose up -d @rest
    }
    'ollama-doctor' {
        $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
        try {
            $version = Invoke-AgentXBoundedRestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 3 -MaximumResponseBytes $agentXOllamaVersionResponseLimitBytes -MaximumRedirection 0
            Write-Output "Native Ollama is healthy at http://127.0.0.1:11434 (version $($version.version))."
            if ($ollamaCommand) { Write-Output "CLI: $($ollamaCommand.Source)" }
            exit 0
        }
        catch {
            if ($ollamaCommand) {
                Write-Output "Ollama is installed at $($ollamaCommand.Source), but its API is not responding."
                Write-Output "Start the Ollama app or run 'ollama serve' in another terminal."
                exit 1
            }
            Write-Output 'Ollama is not installed or not on PATH.'
            Write-Output 'Review https://docs.ollama.com/windows; Agent X will not install it automatically.'
            exit 1
        }
    }
    'ollama-up' {
        Assert-DockerReady
        Ensure-BenchmarkToken
        Ensure-RecoveryToken
        & docker compose @ollamaCompose --profile ollama up -d --wait --wait-timeout 180 @rest ollama mongo qdrant core benchmark rag
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('The Docker Ollama stack did not become healthy within 180 seconds. Run ''.\agentx.ps1 status'' and inspect logs.')
            exit $LASTEXITCODE
        }
        if (-not (Wait-PublishedProductEndpoints)) { exit 1 }
        Write-Output 'Agent X started with isolated Docker Ollama. No model was downloaded.'
    }
    'ollama-status' {
        Assert-DockerReady
        & docker compose @ollamaCompose --profile ollama ps
        if ($LASTEXITCODE -eq 0) {
            & docker compose @ollamaCompose --profile ollama exec ollama ollama list
        }
    }
    'ollama-pull' {
        if ($rest.Count -ne 1) { [Console]::Error.WriteLine('Usage: .\agentx.ps1 ollama-pull <model>'); exit 2 }
        Assert-DockerReady
        & docker compose @ollamaCompose --profile ollama exec ollama ollama pull $rest[0]
    }
    'ollama-down' {
        Assert-DockerReady
        & docker compose @ollamaCompose --profile ollama down @rest
    }
    'reset' {
        Assert-DockerReady
        Write-Output 'This deletes only agentx-ecosystem containers, network, named data volumes, and persistent recovery archives.'
        $confirm = Read-Host "Type 'delete agentx-ecosystem data and recovery archives' to continue"
        if ($confirm -eq 'delete agentx-ecosystem data and recovery archives') {
            & docker compose @ollamaCompose --profile ollama down --volumes
        }
        else {
            Write-Output 'Cancelled.'
        }
    }
    { $_ -in '', '-h', '--help', 'help' } {
        Show-Usage
    }
    default {
        [Console]::Error.WriteLine("Unknown command: $cmd")
        Show-Usage
        exit 2
    }
}
