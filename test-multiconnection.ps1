# Script de PowerShell para ejecutar test de multiconexión
# Uso: .\test-multiconnection.ps1 -EventId "YOUR_EVENT_ID" -Users 10 -Duration 3

param(
    [Parameter(Mandatory=$true)]
    [string]$EventId,
    
    [Parameter(Mandatory=$false)]
    [int]$Users = 10,
    
    [Parameter(Mandatory=$false)]
    [int]$Duration = 3,
    
    [Parameter(Mandatory=$false)]
    [string]$EnvFile = ".env.test"
)

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "       TEST DE MULTICONEXION - SISTEMA DE METRICAS         " -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Verificar que existe el archivo .env.test
if (-not (Test-Path $EnvFile))
{
    Write-Host "Error: Archivo $EnvFile no encontrado" -ForegroundColor Red
    Write-Host ""
    Write-Host "Crea el archivo copiando el ejemplo:" -ForegroundColor Yellow
    Write-Host "   Copy-Item .env.test.example $EnvFile" -ForegroundColor White
    Write-Host "   # Edita $EnvFile con tus valores" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Cargar variables de entorno
Write-Host "Cargando variables de entorno desde $EnvFile..." -ForegroundColor Blue

Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$')
    {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        
        if ($name -and $value)
        {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
            Write-Host "   OK $name configurado" -ForegroundColor Green
        }
    }
}

Write-Host ""

# Verificar variables requeridas
$API_URL = [Environment]::GetEnvironmentVariable("API_URL", "Process")
$FIREBASE_WEB_API_KEY = [Environment]::GetEnvironmentVariable("FIREBASE_WEB_API_KEY", "Process")
$FIREBASE_DATABASE_URL = [Environment]::GetEnvironmentVariable("FIREBASE_DATABASE_URL", "Process")

if (-not $API_URL)
{
    Write-Host "Error: API_URL no esta configurada en $EnvFile" -ForegroundColor Red
    exit 1
}

if (-not $FIREBASE_WEB_API_KEY)
{
    Write-Host "Error: FIREBASE_WEB_API_KEY no esta configurada en $EnvFile" -ForegroundColor Red
    exit 1
}

if (-not $FIREBASE_DATABASE_URL)
{
    Write-Host "Error: FIREBASE_DATABASE_URL no esta configurada en $EnvFile" -ForegroundColor Red
    exit 1
}

Write-Host "Variables de entorno configuradas correctamente" -ForegroundColor Green
Write-Host ""
Write-Host "Iniciando test..." -ForegroundColor Yellow
Write-Host "   Event ID:  $EventId" -ForegroundColor White
Write-Host "   Usuarios:  $Users" -ForegroundColor White
Write-Host "   Duracion:  $Duration minutos" -ForegroundColor White
Write-Host ""

# Ejecutar el script
node scripts/test-multiconnection-simple.js --event-id=$EventId --users=$Users --duration=$Duration

$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0)
{
    Write-Host "Test completado exitosamente" -ForegroundColor Green
}
else
{
    Write-Host "Test fallo con codigo de salida: $exitCode" -ForegroundColor Red
}

Write-Host ""
exit $exitCode
