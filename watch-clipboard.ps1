# 小鹈鹕 V3 — 剪贴板监听器（微信聊天记录自动捕获）
# 兼容 Windows PowerShell 5.1，零第三方依赖。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File watch-clipboard.ps1
#
# 支持两种微信复制格式：
#   A. 单行式：昵称 2026年08月16日 20:27 内容
#   B. 块式（微信实际输出）：昵称 / 时间 / 内容 各占一行，消息之间空行分隔
#
# 逻辑：轮询剪贴板 -> 嗅探聊天格式 -> 解析去重 -> 写 inbox.jsonl + pending.jsonl
#       -> 静默去抖后调 _process_batches.js（纯代码归档，无 Agent）-> 微信推送固定消息。

[CmdletBinding()]
param(
    [int]$PollMs = 700,
    [int]$DebounceMs = 2500,
    [int]$MinMatchLines = 2
)

$ErrorActionPreference = 'Stop'
$script:Root = $PSScriptRoot
$script:DataDir = $env:XIAOTIHU_DATA_DIR
if ($script:DataDir) {
    # 打包模式：所有数据都在数据目录
    $script:ConfigPath = Join-Path $script:DataDir 'config.json'
    $script:Inbox = Join-Path $script:DataDir 'inbox.jsonl'
    $script:Pending = Join-Path $script:DataDir 'pending.jsonl'
    $script:Batches = Join-Path $script:DataDir 'batches'
    $script:Contacts = Join-Path $script:DataDir 'contacts'
    $script:LogDir = Join-Path $script:DataDir 'logs'
    $script:StatePath = Join-Path $script:DataDir '.watcher-state.json'
    $script:RemarkPending = Join-Path $script:DataDir 'remark-pending.json'
    $script:VoicePendingPath = Join-Path $script:DataDir 'voice-pending.json'
    $script:IntentLastRunPath = Join-Path $script:DataDir 'intent-last-run.json'
    $script:ActivityLog = Join-Path $script:DataDir 'activity.log'
    $script:PidFile = Join-Path $script:DataDir '.watcher.pid'
} else {
    # 开发模式：沿用当前路径
    $script:ConfigPath = Join-Path $Root 'config.json'
    $script:Inbox = Join-Path $Root 'inbox.jsonl'
    $script:Pending = Join-Path $Root 'pending.jsonl'
    $script:Batches = Join-Path $Root 'batches'
    $script:Contacts = Join-Path $script:Root 'contacts'
    $script:LogDir = Join-Path $Root 'logs'
    $script:StatePath = Join-Path $Root '.watcher-state.json'
    $script:RemarkPending = Join-Path $Root 'remark-pending.json'
    $script:VoicePendingPath = Join-Path $Root 'voice-pending.json'
    $script:IntentLastRunPath = Join-Path $Root 'intent-last-run.json'
    $script:ActivityLog = Join-Path $Root 'activity.log'
    $script:PidFile = Join-Path $Root '.watcher.pid'
}
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 目录就绪
foreach ($d in @($Batches, $Contacts, $LogDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# 写 PID 文件（供启动器判断是否已在运行，防重复启动）
[System.IO.File]::WriteAllText($script:PidFile, "$PID", $utf8)

# 读取配置（可覆盖参数默认值）
$script:SelfNames = @()
$script:WeixinPush = $null
$script:InboxMax = 500
$script:IntentMinIntervalMs = 600000
if (Test-Path $ConfigPath) {
    try {
        $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.selfNicknames) { $script:SelfNames = @($cfg.selfNicknames) }
        if ($cfg.pollMs) { $PollMs = [int]$cfg.pollMs }
        if ($cfg.debounceMs) { $DebounceMs = [int]$cfg.debounceMs }
        if ($cfg.minMatchLines) { $MinMatchLines = [int]$cfg.minMatchLines }
        if ($cfg.inboxMaxLines) { $script:InboxMax = [int]$cfg.inboxMaxLines }
        if ($cfg.weixinPush) { $script:WeixinPush = $cfg.weixinPush }
        if ($cfg.intent -and $cfg.intent.minIntervalMinutes) { $script:IntentMinIntervalMs = [int]$cfg.intent.minIntervalMinutes * 60000 }
    } catch { Write-Warning "config.json 解析失败，使用默认参数" }
}

# 定位 openclaw（用于微信推送）与 node（用于纯代码批次处理）
$script:Openclaw = $null
$cmd = Get-Command openclaw -ErrorAction SilentlyContinue
if ($cmd) { $script:Openclaw = $cmd.Source }
$script:Node = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $script:Node = $nodeCmd.Source }
$script:ProcessScript = Join-Path $Root '_process_batches.js'
$script:ExtractIntents = Join-Path $Root 'extract_intents.js'

# ---------- 去重状态 ----------
$script:Seen = @{}
if (Test-Path $StatePath) {
    try {
        $st = Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($h in @($st.seenHashes)) { $script:Seen[$h] = $true }
    } catch {}
}
# 用 inbox 尾部回灌，防止状态文件丢失导致重复入库
if (Test-Path $Inbox) {
    try {
        $tail = Get-Content $Inbox -Tail 5000 -Encoding UTF8
        foreach ($ln in $tail) {
            try {
                $o = $ln | ConvertFrom-Json
                $script:Seen[("{0}|{1}|{2}|{3}" -f $o.name, $o.ts, $o.type, $o.content)] = $true
            } catch {}
        }
    } catch {}
}

# ---------- 语音回填状态 ----------
$script:VoicePending = @()
if (Test-Path $script:VoicePendingPath) {
    try {
        $vp = Get-Content $script:VoicePendingPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($vp) { $script:VoicePending = @($vp) }
    } catch {}
}

function Get-SafeFileName([string]$name) {
    $s = [string]$name
    $s = $s -replace '[\\/:*?"<>|]', ''
    $s = $s -replace '^[\s.]+|[\s.]+$', ''
    if ([string]::IsNullOrWhiteSpace($s)) { return 'contact' }
    return $s
}

function Save-VoicePending {
    $json = '[]'
    if ($script:VoicePending.Count -gt 0) {
        $json = $script:VoicePending | ConvertTo-Json -Depth 5
    }
    [System.IO.File]::WriteAllText($script:VoicePendingPath, $json, $utf8)
}

function Add-VoicePending($m, $contact) {
    $effectiveContact = $contact
    if ([string]::IsNullOrWhiteSpace($effectiveContact)) { $effectiveContact = $m.name }
    $entry = [pscustomobject]@{
        seq     = $script:VoicePending.Count + 1
        contact = $effectiveContact
        name    = $m.name
        ts      = $m.ts
        type    = $m.type
        content = ''
    }
    $script:VoicePending += $entry
    Save-VoicePending
    Write-Host ("[v3] 语音待回填 #" + $entry.seq + "：" + $contact + " " + $m.ts)
}

function Update-MessageLineInFile([string]$path, $p) {
    if (-not (Test-Path $path)) { return $false }
    $lines = @(Get-Content $path -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($lines.Count -eq 0) { return $false }
    $out = New-Object System.Collections.Generic.List[string]
    $updated = $false
    foreach ($ln in $lines) {
        if (-not $updated) {
            try {
                $o = $ln | ConvertFrom-Json
                if ($o.name -eq $p.name -and $o.ts -eq $p.ts -and $o.type -eq $p.type -and $o.content -eq '') {
                    $o.content = $p.content
                    $out.Add(($o | ConvertTo-Json -Compress))
                    $updated = $true
                    continue
                }
            } catch {}
        }
        $out.Add($ln)
    }
    if ($updated) {
        [System.IO.File]::WriteAllLines($path, $out.ToArray(), $utf8)
    }
    return $updated
}

function Update-ContactVoice($p) {
    $safe = Get-SafeFileName $p.contact
    $fp = Join-Path $script:Contacts ($safe + '.json')
    if (-not (Test-Path $fp)) { return $false }
    try {
        $doc = Get-Content $fp -Raw -Encoding UTF8 | ConvertFrom-Json
        for ($i = 0; $i -lt $doc.messages.Count; $i++) {
            $m = $doc.messages[$i]
            if ($m.name -eq $p.name -and $m.ts -eq $p.ts -and $m.type -eq $p.type -and $m.content -eq '') {
                $doc.messages[$i].content = $p.content
                [System.IO.File]::WriteAllText($fp, ($doc | ConvertTo-Json -Depth 10), $utf8)
                return $true
            }
        }
    } catch {}
    return $false
}

function Fill-VoicePending([string]$text) {
    if ($script:VoicePending.Count -eq 0) { return $false }
    $newContent = [string]$text
    $newContent = $newContent.Trim()
    if ($newContent -eq '') { return $false }

    $p = $script:VoicePending[0]
    $p.content = $newContent
    $script:VoicePending = @($script:VoicePending | Select-Object -Skip 1)
    Save-VoicePending

    # 如果还没进归档（pending.json 还在），直接改 pending 里的占位
    $updatedPending = Update-MessageLineInFile $script:Pending $p
    # 如果已经归档，则改 contacts JSON
    $updatedContact = $false
    if (-not $updatedPending) {
        $updatedContact = Update-ContactVoice $p
    }
    # 顺手同步 inbox，保持全量流水一致
    Update-MessageLineInFile $script:Inbox $p | Out-Null

    Write-Host ("[v3] 语音回填：" + $p.contact + " " + $p.ts + " => " + $newContent)
    return $true
}

function Get-MsgHash($o) {
    return "{0}|{1}|{2}|{3}" -f $o.name, $o.ts, $o.type, $o.content
}

function Save-State {
    $h = @($script:Seen.Keys)
    if ($h.Count -gt 100000) { $h = @($h | Select-Object -Last 100000) }
    [System.IO.File]::WriteAllText($script:StatePath, (@{ seenHashes = $h } | ConvertTo-Json -Compress), $utf8)
}

function Trim-Inbox([int]$max) {
    if (-not (Test-Path $script:Inbox) -or $max -le 0) { return }
    $lines = @(Get-Content $script:Inbox -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($lines.Count -le $max) { return }
    $keep = @($lines | Select-Object -Last $max)
    [System.IO.File]::WriteAllText($script:Inbox, ($keep -join "`n") + "`n", $utf8)
}

# 结构占位符（非文本消息类型）；emoji 如 [愉快]/[坏笑]/[捂脸] 不属于此列，保留为文本
$script:Structural = '动画表情|图片|语音|视频|文件|链接|位置|转账|红包|小程序|名片|引用'
$script:TsLineRx = New-Object System.Text.RegularExpressions.Regex('^(\d{4}年\d{1,2}月\d{1,2}日)\s+(\d{1,2}:\d{2})$')
$script:LineRx = New-Object System.Text.RegularExpressions.Regex('^(?<name>.+?)\s+(?<date>\d{4}年\d{1,2}月\d{1,2}日)\s+(?<time>\d{1,2}:\d{2})(?:\s+(?<content>.*))?$')

function Classify-Content([string]$content) {
    if ($content -match ('^\[(' + $script:Structural + ')\]')) {
        return @($Matches[1], '')
    }
    return @('text', $content)
}

# 把一条块（[昵称, 时间, 内容...]）转成消息对象；不合法返回 $null
function Convert-BlockToMsg($block) {
    if ($block.Count -lt 3) { return $null }
    $name = $block[0].Trim()
    $tsLine = $block[1].Trim()
    $m = $script:TsLineRx.Match($tsLine)
    if (-not $m.Success) { return $null }
    $ts = ($m.Groups[1].Value -replace '年','-' -replace '月','-' -replace '日','') + ' ' + $m.Groups[2].Value
    $parts = New-Object System.Collections.Generic.List[string]
    for ($i = 2; $i -lt $block.Count; $i++) { $parts.Add($block[$i].Trim()) }
    $content = ($parts -join ' ')
    $cls = Classify-Content $content
    return [pscustomobject]@{ name = $name; ts = $ts; type = $cls[0]; content = $cls[1] }
}

# 策略 B：块格式
function Parse-BlockFormat([string]$Text) {
    $out = New-Object System.Collections.Generic.List[object]
    $block = New-Object System.Collections.Generic.List[string]
    foreach ($raw in ($Text -split "`r?`n")) {
        $ln = $raw.TrimEnd("`r")
        if ($ln.Trim() -eq '') {
            if ($block.Count -ge 3) { $m = Convert-BlockToMsg $block; if ($m) { $out.Add($m) } }
            $block = New-Object System.Collections.Generic.List[string]
        } else {
            $block.Add($ln)
        }
    }
    if ($block.Count -ge 3) { $m = Convert-BlockToMsg $block; if ($m) { $out.Add($m) } }
    return ,$out
}

# 策略 A：单行格式
function Parse-LineFormat([string]$Text) {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($raw in ($Text -split "`r?`n")) {
        $ln = $raw.TrimEnd("`r","`n"," ")
        if ($ln -eq '') { continue }
        $m = $script:LineRx.Match($ln)
        if (-not $m.Success) { continue }
        $name = $m.Groups['name'].Value.Trim()
        $date = $m.Groups['date'].Value; $time = $m.Groups['time'].Value
        $content = ''
        if ($m.Groups['content'].Success) { $content = $m.Groups['content'].Value.Trim() }
        $cls = Classify-Content $content
        $ts = ($date -replace '年','-' -replace '月','-' -replace '日','') + ' ' + $time
        $out.Add([pscustomobject]@{ name = $name; ts = $ts; type = $cls[0]; content = $cls[1] })
    }
    return ,$out
}

function Parse-ChatText([string]$Text) {
    $blocks = Parse-BlockFormat $Text
    if ($blocks.Count -ge 2) { return ,$blocks }
    return ,(Parse-LineFormat $Text)
}

function Get-BatchContact($msgs) {
    $names = @($msgs | ForEach-Object { $_.name } | Sort-Object -Unique)
    $nonSelf = @($names | Where-Object { $script:SelfNames -notcontains $_ })
    if ($nonSelf.Count -eq 1) { return $nonSelf[0] }
    return ''
}

function Add-Messages($msgs, $contact) {
    $newCount = 0
    foreach ($m in $msgs) {
        $hash = Get-MsgHash $m
        if ($script:Seen.ContainsKey($hash)) { continue }
        $script:Seen[$hash] = $true
        $rec = @{ name = $m.name; ts = $m.ts; type = $m.type; content = $m.content; contact = $contact }
        $line = ($rec | ConvertTo-Json -Compress)
        [System.IO.File]::AppendAllText($script:Inbox, $line + "`n", $utf8)
        [System.IO.File]::AppendAllText($script:Pending, $line + "`n", $utf8)
        if ($m.type -eq '语音') {
            Add-VoicePending $m $contact
        }
        $newCount++
    }
    if ($newCount -gt 0) {
        Save-State
        Trim-Inbox $script:InboxMax
    }
    return $newCount
}

function Send-Weixin([string]$msg) {
    if (-not $script:WeixinPush -or -not $script:WeixinPush.enabled) { return }
    $target = $script:WeixinPush.to
    $account = $script:WeixinPush.accountId
    if (-not $target -or -not $account -or -not $script:Openclaw) {
        Write-ActivityLog 'warn' 'weixin' '推送配置不完整，跳过'
        return
    }
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:Openclaw message send --channel openclaw-weixin --account $account --target $target --message $msg *>&1 | Out-Null
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            Write-Host ("[v3] 已推送微信: " + $msg)
            Write-ActivityLog 'info' 'weixin' ("推送成功: " + $msg)
        } else {
            Write-Warning ("[v3] 微信推送失败 exit=" + $code)
            Write-ActivityLog 'error' 'weixin' ("推送失败 exit=" + $code + ": " + $msg)
        }
    } catch {
        Write-Warning ("[v3] 微信推送失败: " + $_.Exception.Message)
        Write-ActivityLog 'error' 'weixin' ("推送异常: " + $_.Exception.Message)
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}

function Send-WeixinPush([int]$n) {
    if ($script:WeixinPush -and ($script:WeixinPush.notifyComplete -eq $false)) { return }
    Send-Weixin ("本次一共处理 " + $n + " 条聊天记录，吃饱啦")
}

function Add-RemarkPending([string]$name) {
    $h = @{}
    if (Test-Path $script:RemarkPending) {
        try {
            $existing = Get-Content $script:RemarkPending -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $existing.PSObject.Properties) { $h[$p.Name] = $p.Value }
        } catch {}
    }
    if (-not $h.ContainsKey($name)) {
        $h[$name] = [pscustomobject]@{ askedAt = (Get-Date -Format 'o') }
        [System.IO.File]::WriteAllText($script:RemarkPending, ($h | ConvertTo-Json), $utf8)
        Write-Host ("[v3] 已登记待备注联系人: " + $name)
    }
}

function Write-ActivityLog([string]$level, [string]$source, [string]$message) {
    try {
        $entry = @{ ts = (Get-Date -Format 'o'); level = $level; source = $source; message = $message } | ConvertTo-Json -Compress
        [System.IO.File]::AppendAllText($script:ActivityLog, $entry + "`n", $utf8)
    } catch {}
}

function Should-RunIntentExtract {
    if (-not $script:Node -or -not (Test-Path $script:ExtractIntents)) { return $false }
    if (Test-Path $script:IntentLastRunPath) {
        try {
            $st = Get-Content $script:IntentLastRunPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $last = [datetime]$st.lastRunAt
            if (((Get-Date) - $last).TotalMilliseconds -lt $script:IntentMinIntervalMs) { return $false }
        } catch {}
    }
    return $true
}

function Invoke-IntentExtract {
    if (-not (Should-RunIntentExtract)) { return }
    Write-Host "[v3] 触发意图识别..."
    Write-ActivityLog 'info' 'watcher' '触发意图识别'
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:Node $script:ExtractIntents *>&1 | Out-Host
    } catch {
        Write-Warning ("[v3] 意图识别失败: " + $_.Exception.Message)
        Write-ActivityLog 'error' 'watcher' ("意图识别失败: " + $_.Exception.Message)
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    [System.IO.File]::WriteAllText($script:IntentLastRunPath, (@{ lastRunAt = (Get-Date -Format 'o') } | ConvertTo-Json -Compress), $utf8)
}

function Process-Pending {
    if (-not (Test-Path $script:Pending)) { return }
    $items = @(Get-Content $script:Pending -ErrorAction SilentlyContinue -Encoding UTF8)
    if ($items.Count -eq 0) { return }
    $n = $items.Count

    # 归档前快照已有联系人（用于识别新联系人）
    $before = @(Get-ChildItem $script:Contacts -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

    $batch = Join-Path $script:Batches ('batch-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.jsonl')
    Move-Item -Path $script:Pending -Destination $batch -Force
    Write-Host ("[v3] 处理批次: " + (Split-Path $batch -Leaf) + " (" + $n + " 条)")

    if (-not $script:Node -or -not (Test-Path $script:ProcessScript)) {
        Write-Warning "[v3] 未找到 node 或处理脚本，批次保留在 batches/"
        return
    }

    $added = $n
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& $script:Node $script:ProcessScript 2>&1 | Out-String).Trim()
        if ($out -match '^\d+$') { $added = [int]$out }
        Write-Host ("[v3] 归档完成，新增 " + $added + " 条")
        Write-ActivityLog 'info' 'watcher' ("归档完成，新增 " + $added + " 条")
    } catch {
        Write-Warning ("[v3] 批次处理失败: " + $_.Exception.Message + "（批次保留在 batches/）")
        return
    } finally {
        $ErrorActionPreference = $prevEAP
    }

    # 推送固定消息
    Send-WeixinPush $added

    # 识别新联系人并提示补充备注
    $after = @(Get-ChildItem $script:Contacts -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $newContacts = @($after | Where-Object { $before -notcontains $_ })
    foreach ($nc in $newContacts) {
        $nm = $nc -replace '\.json$', ''
        Send-Weixin ("发现新联系人「" + $nm + "」，请回复备注名（例如：杨老师），我会记到档案里；暂不备注可忽略本条。")
        Add-RemarkPending $nm
        Write-ActivityLog 'info' 'watcher' ("发现新联系人 " + $nm)
    }

    # 事件驱动意图识别：新聊天归档后触发（带冷却，避免频繁调模型）
    Invoke-IntentExtract
}

# ---------- 主循环 ----------
$lastClip = ''
$lastChange = [datetime]::MinValue
Write-Host "[v3] 监听开始 (poll=$PollMs ms, debounce=$DebounceMs ms, minLines=$MinMatchLines)。在微信里复制聊天记录即可。Ctrl+C 退出。"

while ($true) {
    try {
        $clip = Get-Clipboard -Raw -ErrorAction Stop
    } catch {
        $clip = $lastClip
    }

    if ($clip -and ($clip -ne $lastClip)) {
        $lastClip = $clip
        $msgs = Parse-ChatText $clip
        if ($msgs.Count -ge $MinMatchLines) {
            $contact = Get-BatchContact $msgs
            $newCount = Add-Messages $msgs $contact
            if ($newCount -gt 0) {
                Write-Host ("[v3] 捕获 " + $newCount + " 条新消息")
                Write-ActivityLog 'info' 'watcher' ("捕获 " + $newCount + " 条新消息")
                $lastChange = Get-Date
            }
        } elseif ($script:VoicePending.Count -gt 0 -and $msgs.Count -eq 0) {
            if (Fill-VoicePending $clip) {
                Write-Host ("[v3] 语音待回填剩余 " + $script:VoicePending.Count + " 条")
            }
        } elseif ($clip -match '\d{4}年\d{1,2}月\d{1,2}日') {
            Write-Host ("[v3] 检测到含日期的文本，但只解析出 " + $msgs.Count + " 条（<" + $MinMatchLines + "），已忽略。若这是聊天记录，请把完整内容复制给我排查。")
        }
    }

    # 静默去抖后触发归档（纯代码，无 Agent）
    if ((Test-Path $script:Pending) -and ((Get-Date) - $lastChange).TotalMilliseconds -gt $DebounceMs) {
        Process-Pending
    }

    Start-Sleep -Milliseconds $PollMs
}
