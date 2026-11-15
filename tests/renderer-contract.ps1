param([string]$ScriptsRoot, [string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$owner = Join-Path $ScriptsRoot 'utilities\powershell\Set-NightLight.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($owner, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "PowerShell owner has syntax errors: $errors" }
foreach ($name in @('Get-BrightnessDisplayEffects', 'New-WarmColorEffect')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($definitions.Count -ne 1) { throw "Expected one canonical $name function" }
    Invoke-Expression $definitions[0].Extent.Text
}
function Write-NightLightLog { param([string]$Message) throw $Message }
$BrightnessConfigPath = $ConfigPath
Add-Type -Path (Join-Path $ScriptsRoot 'utilities\powershell\NightFilter.Native.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
$effects = @(Get-BrightnessDisplayEffects)
if ($effects.Count -ne 1) { throw "Expected exactly one gain effect; got $($effects.Count)" }
$normal = New-WarmColorEffect -FilterStrength 0 -FilterDimness 0 -SignalGain $effects[0].signal_gain
$warm = New-WarmColorEffect -FilterStrength 100 -FilterDimness 0 -SignalGain 2
$dim = New-WarmColorEffect -FilterStrength 0 -FilterDimness 80
@{gain=$effects[0].signal_gain; red=$normal.Transform[0]; warmGreen=$warm.Transform[6]; dimRed=$dim.Transform[0]} | ConvertTo-Json -Compress
