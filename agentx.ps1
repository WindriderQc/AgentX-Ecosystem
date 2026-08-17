$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$envFile = Join-Path $root 'config\agentx.env'
$compose = @('--project-name', 'agentx-ecosystem', '--env-file', $envFile, '-f', 'docker-compose.yml')
$ollamaCompose = $compose + @('-f', 'docker-compose.ollama.yml')

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

function Show-Usage {
    @"
Agent X Ecosystem

Usage: .\agentx.ps1 <command> [args...]

Commands:
  doctor                Check Docker CLI, Compose, and engine availability
  up                    Start the demo and wait for product health
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
  reset                 Delete only agentx-ecosystem containers and volumes

Open http://localhost:3180/ after startup.
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
        & docker compose @compose up -d --wait --wait-timeout 180 @rest mongo qdrant core benchmark rag
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('Startup did not become healthy within 180 seconds. Run ''.\agentx.ps1 status'' and ''.\agentx.ps1 logs core''.')
            exit $LASTEXITCODE
        }
        $corePort = if ($env:CORE_PORT) { $env:CORE_PORT } else { '3180' }
        Write-Output "Agent X started: http://localhost:$corePort/"
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
        & docker compose @compose build --no-cache @rest
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & docker compose @compose up -d @rest
    }
    'ollama-doctor' {
        $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
        try {
            $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 3
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
        & docker compose @ollamaCompose --profile ollama up -d --wait --wait-timeout 180 @rest ollama mongo qdrant core benchmark rag
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('The Docker Ollama stack did not become healthy within 180 seconds. Run ''.\agentx.ps1 status'' and inspect logs.')
            exit $LASTEXITCODE
        }
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
        Write-Output 'This deletes only agentx-ecosystem containers, network, and named data volumes.'
        $confirm = Read-Host "Type 'delete agentx-ecosystem data' to continue"
        if ($confirm -eq 'delete agentx-ecosystem data') {
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
