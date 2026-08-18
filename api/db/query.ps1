<#
    query.ps1 - run a read-only SELECT against Noble and print the rows.

    Same connection handling as apply.ps1: read from the gitignored api/.env so
    a production password never reaches a command line. Separate from apply.ps1
    because this one is for LOOKING, and this database is the live LIS - the
    two want different levels of care from whoever is typing.

    Usage:
        powershell -File api/db/query.ps1 -Sql "SELECT TOP 5 * FROM dbo.x"
#>
param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [string]$EnvFile
)

$ErrorActionPreference = 'Stop'

# Resolved in the BODY, not as a param default — see apply.ps1.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $EnvFile) { $EnvFile = Join-Path $here '..\.env' }

if ($Sql -notmatch '(?i)^\s*(SELECT|WITH|EXEC\s+sp_help|SET\s+NOCOUNT)') {
    throw "query.ps1 runs reads only. Use apply.ps1 for anything that changes the database."
}

if (-not (Test-Path $EnvFile)) { throw "No env file at $EnvFile." }

$e = @{}
foreach ($line in Get-Content $EnvFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $e[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}

$cs = "Server=$($e['Noble__Server']);Database=$($e['Noble__Database']);" +
      "User Id=$($e['Noble__User']);Password=$($e['Noble__Password']);" +
      "TrustServerCertificate=true;Encrypt=true;Application Name=InfinityQuery"

$cn = New-Object System.Data.SqlClient.SqlConnection $cs
$cn.Open()
try {
    $cmd = $cn.CreateCommand()
    $cmd.CommandText = $Sql
    $cmd.CommandTimeout = 60
    $a = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $t = New-Object System.Data.DataTable
    [void]$a.Fill($t)
    $t | Format-Table -AutoSize | Out-String -Width 200
}
finally {
    $cn.Close()
}
