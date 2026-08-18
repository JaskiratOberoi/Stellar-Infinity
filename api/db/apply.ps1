<#
    apply.ps1 - run a numbered script from api/db/sql against Noble.

    The connection is read from api/.env, which is gitignored, so a password
    never appears on a command line, in shell history, or in this file. That is
    not a nicety: this database is the LIVE LIS, shared with Telo and Listec.

    Usage:
        powershell -File api/db/apply.ps1 112_usp_inf_payment_intent.sql

    Batches are split on GO the way sqlcmd does, because CREATE PROCEDURE must
    be the first statement in its batch and the whole file would otherwise fail
    as one.
#>
param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string]$EnvFile = "$PSScriptRoot/../.env",
    [string]$SqlDir  = "$PSScriptRoot/sql"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $EnvFile)) { throw "No env file at $EnvFile." }

$env_ = @{}
foreach ($line in Get-Content $EnvFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $env_[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}

foreach ($k in @('Noble__Server', 'Noble__Database', 'Noble__User', 'Noble__Password')) {
    if (-not $env_.ContainsKey($k)) { throw "$k is missing from $EnvFile." }
}

$path = Join-Path $SqlDir $Script
if (-not (Test-Path $path)) { throw "No such script: $path" }

# Application Name tags these sessions in sys.dm_exec_sessions, so a DBA
# looking at the live server can tell what ran and from where.
$cs = "Server=$($env_['Noble__Server']);Database=$($env_['Noble__Database']);" +
      "User Id=$($env_['Noble__User']);Password=$($env_['Noble__Password']);" +
      "TrustServerCertificate=true;Encrypt=true;Application Name=InfinityDeploy"

$sql = Get-Content $path -Raw

# Split on a line that is only GO. A naive -split 'GO' would cut the word out
# of the middle of an identifier or a comment.
$batches = [regex]::Split($sql, '(?im)^\s*GO\s*$') |
           Where-Object { $_.Trim().Length -gt 0 }

Write-Host "Applying $Script - $($batches.Count) batches"

$cn = New-Object System.Data.SqlClient.SqlConnection $cs
$cn.Open()
# PRINT output is how these scripts report what they did; without this handler
# it is discarded and every run looks identical.
$cn.add_InfoMessage({ param($s, $e) Write-Host "  $($e.Message)" })
try {
    $n = 0
    foreach ($b in $batches) {
        $n++
        $cmd = $cn.CreateCommand()
        $cmd.CommandText = $b
        $cmd.CommandTimeout = 180
        [void]$cmd.ExecuteNonQuery()
    }
    Write-Host "OK - $n batches applied."
}
finally {
    $cn.Close()
}
