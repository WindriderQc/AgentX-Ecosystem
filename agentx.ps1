$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$envFile = Join-Path $root 'config\agentx.env'
$compose = @('--project-name', 'agentx-ecosystem', '--env-file', $envFile, '-f', 'docker-compose.yml')
$ollamaCompose = $compose + @('-f', 'docker-compose.ollama.yml')

function Show-Usage {
    @"
Agent X Ecosystem

Usage: .\agentx.ps1 <command> [args...]

Commands:
  up                    Start Core, Benchmark, RAG, MongoDB, and Qdrant
  down                  Stop the product stack; preserve data volumes
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
    'up' {
        & docker compose @compose up -d mongo qdrant core benchmark rag @rest
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Output 'Agent X started: http://localhost:3180/'
    }
    'down' {
        & docker compose @compose down @rest
    }
    { $_ -in 'status', 'ps' } {
        & docker compose @compose ps
    }
    'logs' {
        $service = if ($rest.Count -gt 0) { $rest[0] } else { 'core' }
        & docker compose @compose logs -f --tail=200 $service
    }
    'rebuild' {
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
        & docker compose @ollamaCompose --profile ollama up -d ollama mongo qdrant core benchmark rag @rest
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Output 'Agent X started with isolated Docker Ollama. No model was downloaded.'
    }
    'ollama-status' {
        & docker compose @ollamaCompose --profile ollama ps
        if ($LASTEXITCODE -eq 0) {
            & docker compose @ollamaCompose --profile ollama exec ollama ollama list
        }
    }
    'ollama-pull' {
        if ($rest.Count -ne 1) { Write-Error 'Usage: .\agentx.ps1 ollama-pull <model>'; exit 2 }
        & docker compose @ollamaCompose --profile ollama exec ollama ollama pull $rest[0]
    }
    'ollama-down' {
        & docker compose @ollamaCompose --profile ollama down @rest
    }
    'reset' {
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
        Write-Error "Unknown command: $cmd"
        Show-Usage
        exit 2
    }
}
