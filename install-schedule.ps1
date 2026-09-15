# Registers the daily AI news digest as a Windows scheduled task.
# Run from PowerShell:  .\install-schedule.ps1
# Remove later with:    Unregister-ScheduledTask -TaskName "AI News Digest" -Confirm:$false

$bun    = "C:\Users\toaya\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"
$script = "C:\Users\toaya\bc-academy\tools\ai-news-feed\feed.ts"

if (-not (Test-Path $bun))    { throw "bun.exe not found at $bun" }
if (-not (Test-Path $script)) { throw "feed.ts not found at $script" }

$action  = New-ScheduledTaskAction -Execute $bun -Argument ('run "{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -Daily -At "07:30"

# StartWhenAvailable matters: you split time between the UK and Dubai, so the
# laptop will often be asleep at 07:30. This runs the digest at next wake
# instead of silently skipping the day.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName "AI News Digest" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Daily AI news digest to Telegram via @ayaz_feeds_bot" `
    -Force | Out-Null

Get-ScheduledTask -TaskName "AI News Digest" | Select-Object TaskName, State
"Next run: " + (Get-ScheduledTaskInfo -TaskName "AI News Digest").NextRunTime
