param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Subject,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Date,

  [ValidateNotNullOrEmpty()]
  [string]$RunId = ("owa-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()),

  [string]$Sender = "",

  [string]$AttachmentNamePattern = "\.(pdf|pptx?|docx|xlsx)$",

  [string]$BrainWorkDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "brain-work"),

  [string]$DownloadDir = "",

  [string]$OwaUrl = "https://outlook.office.com/mail/",

  [string]$MessageUrl = "",

  [string]$EdgePath = "",

  [int]$DebugPort = 0,

  [ValidateRange(30, 900)]
  [int]$TimeoutSeconds = 240,

  [switch]$Visible,

  [switch]$KeepBrowserOpen,

  [switch]$ValidateOnly,

  [switch]$Json
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function ConvertTo-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Test-IsPathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Parent
  )
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return $childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or
    $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeRunId {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
    throw "RunId must be 1-80 characters and contain only letters, digits, dot, underscore, or hyphen."
  }
  if ($Value -match '\.\.') {
    throw "RunId must not contain path traversal."
  }
}

function Resolve-BrainWorkDir {
  param([Parameter(Mandatory = $true)][string]$Value)
  $full = ConvertTo-FullPath $Value
  if ([System.IO.Path]::GetFileName($full).ToLowerInvariant() -ne "brain-work") {
    throw "BrainWorkDir must resolve to a directory named brain-work: $full"
  }
  New-Item -ItemType Directory -Force -Path $full | Out-Null
  return $full
}

function Resolve-DownloadDir {
  param(
    [Parameter(Mandatory = $true)][string]$BrainWork,
    [Parameter(Mandatory = $true)][string]$Run,
    [string]$Requested
  )
  $attachmentsRoot = Join-Path $BrainWork "attachments"
  $expectedRunRoot = Join-Path $attachmentsRoot $Run
  $target = if ([string]::IsNullOrWhiteSpace($Requested)) { $expectedRunRoot } else { ConvertTo-FullPath $Requested }

  $targetFull = [System.IO.Path]::GetFullPath($target)
  $attachmentsFull = [System.IO.Path]::GetFullPath($attachmentsRoot)
  $expectedFull = [System.IO.Path]::GetFullPath($expectedRunRoot)

  if (-not (Test-IsPathInside -Child $targetFull -Parent $attachmentsFull)) {
    throw "DownloadDir must stay inside brain-work/attachments: $targetFull"
  }
  if (-not (Test-IsPathInside -Child $targetFull -Parent $expectedFull)) {
    throw "DownloadDir must stay inside this run directory: $expectedFull"
  }

  New-Item -ItemType Directory -Force -Path $targetFull | Out-Null
  return $targetFull
}

function Resolve-ProfileDir {
  param(
    [Parameter(Mandatory = $true)][string]$BrainWork,
    [Parameter(Mandatory = $true)][string]$Run
  )
  $root = Join-Path $BrainWork "owa-profiles"
  $profile = Join-Path $root $Run
  $profileFull = [System.IO.Path]::GetFullPath($profile)
  $rootFull = [System.IO.Path]::GetFullPath($root)
  if (-not (Test-IsPathInside -Child $profileFull -Parent $rootFull)) {
    throw "ProfileDir must stay inside brain-work/owa-profiles: $profileFull"
  }
  if (Test-Path -LiteralPath $profileFull) {
    Remove-Item -LiteralPath $profileFull -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $profileFull | Out-Null
  return $profileFull
}

function Resolve-EdgePath {
  param([string]$Requested)
  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    $full = ConvertTo-FullPath $Requested
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "EdgePath not found: $full" }
    return $full
  }

  $candidates = @(
    (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:LOCALAPPDATA} "Microsoft\Edge\Application\msedge.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

  if ($candidates.Count -gt 0) { return $candidates[0] }

  $appPathKeys = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
    "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
  )
  foreach ($key in $appPathKeys) {
    if (Test-Path $key) {
      $value = (Get-ItemProperty -Path $key)."(default)"
      if ($value -and (Test-Path -LiteralPath $value -PathType Leaf)) { return $value }
    }
  }

  throw "Microsoft Edge executable was not found. Pass -EdgePath explicitly."
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Convert-PdfToText {
  param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [Parameter(Mandatory = $true)][string]$TextPath
  )
  $pdfToText = Get-Command pdftotext -ErrorAction SilentlyContinue
  if ($pdfToText) {
    & $pdfToText.Source -layout -enc UTF-8 -- $PdfPath $TextPath
    if ($LASTEXITCODE -ne 0) { throw "pdftotext failed with exit code $LASTEXITCODE for $PdfPath" }
    return @{ tool = "pdftotext"; textPath = $TextPath }
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  $pdfParseDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "node_modules\pdf-parse"
  if ($node -and (Test-Path -LiteralPath $pdfParseDir)) {
    $script = @'
const fs = require('fs');
const pdf = require('pdf-parse');
const [,, input, output] = process.argv;
pdf(fs.readFileSync(input)).then(data => fs.writeFileSync(output, data.text || '', 'utf8'));
'@
    $tmpScript = Join-Path ([System.IO.Path]::GetDirectoryName($TextPath)) "_pdf-parse.cjs"
    Set-Content -LiteralPath $tmpScript -Value $script -Encoding UTF8
    try {
      & $node.Source $tmpScript $PdfPath $TextPath
      if ($LASTEXITCODE -ne 0) { throw "pdf-parse failed with exit code $LASTEXITCODE for $PdfPath" }
      return @{ tool = "pdf-parse"; textPath = $TextPath }
    } finally {
      Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
    }
  }

  throw "No PDF text extractor found. Install pdftotext or add pdf-parse as a devDependency."
}

function Stop-OwnedEdge {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$ProfileDir,
    [switch]$Keep
  )
  if ($Keep) { return }
  if ($Process -and -not $Process.HasExited) {
    try { [void]$Process.CloseMainWindow() } catch {}
    try { if (-not $Process.WaitForExit(5000)) { $Process.Kill($true) } } catch {
      try { if (-not $Process.HasExited) { $Process.Kill() } } catch {}
    }
  }
  if ($ProfileDir -and (Test-Path -LiteralPath $ProfileDir)) {
    $brainWork = Resolve-BrainWorkDir $BrainWorkDir
    $profileRoot = Join-Path $brainWork "owa-profiles"
    if ((Test-IsPathInside -Child $ProfileDir -Parent $profileRoot) -and ((Split-Path -Leaf $ProfileDir) -eq $RunId)) {
      Remove-Item -LiteralPath $ProfileDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-Result {
  param([hashtable]$Result)
  if ($Json) {
    $Result | ConvertTo-Json -Depth 8
  } else {
    $Result.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0}: {1}" -f $_.Name, $_.Value }
  }
}

Assert-SafeRunId $RunId
[void][DateTimeOffset]::Parse($Date)
$brainWorkFull = Resolve-BrainWorkDir $BrainWorkDir
$downloadFull = Resolve-DownloadDir -BrainWork $brainWorkFull -Run $RunId -Requested $DownloadDir
$profileFull = Join-Path $brainWorkFull "owa-profiles\$RunId"
$manifestPath = Join-Path $downloadFull "manifest.json"
$nodeScriptPath = Join-Path $downloadFull "_owa-cdp-worker.cjs"
$configPath = Join-Path $downloadFull "_owa-cdp-config.json"

if ($ValidateOnly) {
  Write-Result @{
    ok = $true
    validateOnly = $true
    subject = $Subject
    date = $Date
    runId = $RunId
    brainWorkDir = $brainWorkFull
    downloadDir = $downloadFull
    profileDir = $profileFull
    attachmentNamePattern = $AttachmentNamePattern
    messageUrl = $MessageUrl
  }
  exit 0
}

$edge = $null
$startedProfile = $null
try {
  $edgePathFull = Resolve-EdgePath $EdgePath
  $startedProfile = Resolve-ProfileDir -BrainWork $brainWorkFull -Run $RunId
  $port = if ($DebugPort -gt 0) { $DebugPort } else { Get-FreeTcpPort }

  $edgeArgs = @(
    "--remote-debugging-port=$port",
    "--user-data-dir=$startedProfile",
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-features=msEdgeSidebarV2",
    $OwaUrl
  )
  $startParams = @{
    FilePath = $edgePathFull
    ArgumentList = $edgeArgs
    PassThru = $true
  }
  if (-not $Visible) { $startParams.WindowStyle = "Hidden" }
  $edge = Start-Process @startParams

  $deadline = (Get-Date).AddSeconds([Math]::Min(60, $TimeoutSeconds))
  do {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
      break
    } catch {
      if ((Get-Date) -gt $deadline) { throw "Edge CDP endpoint did not become ready on port $port." }
    }
  } while ($true)

  $config = @{
    subject = $Subject
    date = $Date
    sender = $Sender
    attachmentNamePattern = $AttachmentNamePattern
    owaUrl = $OwaUrl
    messageUrl = $MessageUrl
    port = $port
    timeoutMs = $TimeoutSeconds * 1000
    downloadDir = $downloadFull
    manifestPath = $manifestPath
  }
  Set-Content -LiteralPath $configPath -Value ($config | ConvertTo-Json -Depth 6) -Encoding UTF8

  $nodeScript = @'
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function escRe(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function debugPageSnapshot(page, pattern) {
  return await page.evaluate(({ pattern }) => {
    const re = new RegExp(pattern, 'i');
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 5 && rect.height > 5 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function txt(el) {
      return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('download'), el.getAttribute('href')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const fileLike = [];
    for (const el of document.querySelectorAll('a,button,[role="button"],[aria-label],[title],div,span')) {
      if (!visible(el)) continue;
      const text = txt(el);
      if (!text) continue;
      if (re.test(text) || /\b(attachment|attachments|anlage|anhang|download|herunterladen|pdf|pptx?|docx|xlsx|deck)\b/i.test(text)) {
        fileLike.push({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          text: text.slice(0, 400)
        });
      }
      if (fileLike.length >= 40) break;
    }
    return {
      title: document.title,
      url: location.href,
      bodyTextSample: txt(document.body).slice(0, 3000),
      fileLike,
      resources: performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(name => /attachment|conversation|item|owa\/service|service\.svc|GetFile|GetAttachment|FindConversation|GetConversation/i.test(name))
        .slice(-80)
    };
  }, { pattern }).catch(error => ({ error: String(error) }));
}

function dateTerms(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return [];
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getUTCDate()).padStart(2, '0');
  const hh = String(parsed.getHours()).padStart(2, '0');
  const min = String(parsed.getMinutes()).padStart(2, '0');
  const monthShort = parsed.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const monthLong = parsed.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const terms = [`${yyyy}-${mm}-${dd}`, `${dd}.${mm}.${yyyy}`, `${dd}/${mm}/${yyyy}`, `${monthShort} ${Number(dd)}`, `${monthLong} ${Number(dd)}`];
  const hasExplicitTime = /(?:T|\s)\d{1,2}:\d{2}/.test(String(value || ''));
  if (hasExplicitTime) {
    terms.push(`${hh}:${min}`);
    terms.push(`${Number(hh)}:${min}`);
  }
  return terms;
}

async function waitForOwaReady(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const body = compact(await page.locator('body').innerText({ timeout: 2000 }).catch(() => ''));
    if (/outlook\.office\.com/i.test(url) && /(Inbox|Posteingang|Search|Suchen|Focused|Fokussiert|Mail)/i.test(`${title} ${body}`)) {
      return { url, title };
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('OWA did not reach a signed-in mail view before timeout.');
}

async function runSearch(page, cfg) {
  const queryParts = [`"${cfg.subject}"`, 'hasattachments:yes'];
  if (cfg.sender) queryParts.push(`from:"${cfg.sender}"`);
  const query = queryParts.join(' ');

  const searchLocators = [
    page.getByPlaceholder(/Search or ask Copilot|Search|Suchen/i).first(),
    page.getByRole('searchbox').first(),
    page.locator('input[aria-label*="Search" i], input[placeholder*="Search" i], input[aria-label*="Suchen" i], input[placeholder*="Suchen" i]').first(),
    page.locator('[contenteditable="true"][aria-label*="Search" i], [contenteditable="true"][aria-label*="Suchen" i]').first()
  ];
  let searched = false;
  for (const locator of searchLocators) {
    if (!(await locator.isVisible({ timeout: 1500 }).catch(() => false))) continue;
    await locator.click({ timeout: 5000 });
    const filled = await locator.fill(query, { timeout: 5000 }).then(() => true).catch(async () => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type(query, { delay: 5 });
      return true;
    }).catch(() => false);
    if (!filled) continue;
    await locator.press('Enter').catch(async () => page.keyboard.press('Enter'));
    searched = true;
    break;
  }
  if (!searched) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+E' : 'Control+E');
    await page.keyboard.type(query, { delay: 5 });
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(7000);
  const subjectTail = compact(cfg.subject).split(/\s+/).slice(-4).join(' ');
  await page.waitForFunction(({ subjectTail }) => document.body && document.body.innerText.includes(subjectTail), { subjectTail }, { timeout: 15000 }).catch(() => {});
  return query;
}

async function expandSearchConversationRows(page, cfg) {
  const expanded = await page.evaluate(({ subject }) => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 5 && rect.height > 5 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function txt(el) {
      return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const subjectTail = String(subject || '').split(/\s+/).slice(-4).join(' ').toLowerCase();
    let count = 0;
    for (const row of document.querySelectorAll('[role="option"], [role="row"], [aria-label], div')) {
      if (!visible(row)) continue;
      const rowText = txt(row);
      const lower = rowText.toLowerCase();
      if (!lower.includes(subjectTail)) continue;
      if (!/\(\d+\)|conversation|unterhaltung|collapsed|expanded/i.test(rowText)) continue;
      const controls = [...row.querySelectorAll('[aria-label*="Expand" i], [aria-label*="Erweitern" i], [aria-expanded="false"], button, [role="button"]')]
        .filter(visible);
      const control = controls.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.left - br.left || ar.width * ar.height - br.width * br.height;
      })[0];
      if (control) {
        control.click();
        count++;
      }
    }
    return count;
  }, { subject: cfg.subject }).catch(() => 0);
  if (expanded) await page.waitForTimeout(3000);
  return expanded;
}

async function scoreAndClickMessage(page, cfg) {
  const terms = compact(cfg.subject).split(/\s+/).filter(Boolean);
  const strongTerms = terms.filter(term => term.length >= 5).slice(0, 8);
  const dates = dateTerms(cfg.date);
  const senderTerm = compact(cfg.sender).split(/\s+/).find(term => term.length >= 4) || '';

  const result = await page.evaluate(({ strongTerms, dates, senderTerm }) => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function txt(el) {
      return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const selectors = [
      '[role="option"]',
      '[role="row"]',
      '[data-convid]',
      '[aria-label]',
      'div'
    ];
    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const text = txt(el);
        if (!text) continue;
        const lower = text.toLowerCase();
        let score = 0;
        for (const term of strongTerms) if (lower.includes(term.toLowerCase())) score += 3;
        if (senderTerm && lower.includes(senderTerm.toLowerCase())) score += 2;
        for (const date of dates) if (lower.includes(date.toLowerCase())) score += 1;
        if (/\b(pdf|attachment|anlage|anhang|datei)\b/i.test(text)) score += 1;
        if (score > 0) candidates.push({ el, text, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    const best = candidates[0];
    if (!best || best.score < Math.min(6, strongTerms.length * 2)) {
      return { clicked: false, candidates: candidates.slice(0, 5).map(item => ({ score: item.score, text: item.text.slice(0, 300) })) };
    }
    best.el.scrollIntoView({ block: 'center', inline: 'center' });
    best.el.click();
    best.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, score: best.score, text: best.text.slice(0, 800) };
  }, { strongTerms, dates, senderTerm });

  if (!result.clicked) {
    throw new Error(`Could not identify target message. Top candidates: ${JSON.stringify(result.candidates || [])}`);
  }
  await page.waitForTimeout(3000);
  return result;
}

async function openSelectedMessageView(page, cfg) {
  const opened = await page.evaluate(({ subject }) => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function txt(el) {
      return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const subjectWords = String(subject || '').toLowerCase().split(/\s+/).filter(word => word.length >= 5);
    const rows = [...document.querySelectorAll('[aria-selected="true"], [role="option"], [role="row"], [aria-label], div')]
      .filter(visible)
      .map(el => ({ el, text: txt(el) }))
      .filter(item => item.text && subjectWords.some(word => item.text.toLowerCase().includes(word)));
    rows.sort((a, b) => a.text.length - b.text.length);
    const target = rows[0];
    if (!target) return false;
    target.el.scrollIntoView({ block: 'center', inline: 'center' });
    target.el.click();
    target.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, { subject: cfg.subject }).catch(() => false);
  if (!opened) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return opened;
}

async function expandReadOnlyConversation(page) {
  await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 5 && rect.height > 5 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function txt(el) {
      return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const candidates = [];
    for (const el of document.querySelectorAll('[aria-label*="Collapsed" i], [aria-expanded="false"], [role="button"], button, div')) {
      if (!visible(el)) continue;
      const text = txt(el);
      const lower = text.toLowerCase();
      if (!lower.includes('collapsed') && !lower.includes('reduziert') && !lower.includes('eingeklappt')) continue;
      if (!lower.includes('has attachments') && !lower.includes('attachment') && !lower.includes('anhang')) continue;
      const rect = el.getBoundingClientRect();
      candidates.push({ el, area: rect.width * rect.height, textLength: text.length });
    }
    candidates
      .sort((a, b) => a.area - b.area || a.textLength - b.textLength)
      .slice(0, 5)
      .forEach(item => {
        item.el.scrollIntoView({ block: 'center', inline: 'center' });
        item.el.click();
      });
  }).catch(() => {});
  await page.waitForTimeout(1500);

  const labels = [
    /show more|show all|expand|view entire message|more messages/i,
    /mehr anzeigen|alle anzeigen|erweitern|vollständige nachricht/i
  ];
  for (const label of labels) {
    for (const locator of [
      page.getByRole('button', { name: label }).first(),
      page.getByText(label).first()
    ]) {
      if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
        await locator.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }
  }
}

async function findAttachmentElements(page, pattern) {
  return await page.evaluate(({ pattern }) => {
    const re = new RegExp(pattern, 'i');
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 5 && rect.height > 5 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function txt(el) {
      return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('download'), el.getAttribute('href')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const nodes = [...document.querySelectorAll('a,button,[role="button"],[aria-label],[title],div,span')];
    const hits = [];
    for (let index = 0; index < nodes.length; index++) {
      const el = nodes[index];
      if (!visible(el)) continue;
      const text = txt(el);
      const parentText = el.parentElement ? txt(el.parentElement) : '';
      const combined = `${text} ${parentText}`;
      const role = el.getAttribute('role') || '';
      const isInteractive = ['A', 'BUTTON'].includes(el.tagName) || role === 'button' || el.hasAttribute('aria-label') || el.hasAttribute('title');
      const hasExtension = re.test(combined) || /\.(pdf|pptx?|docx|xlsx)\b/i.test(combined);
      const hasSmallAttachmentLabel = /\b(attachment|attachments|anlage|anhang)\b/i.test(text) && text.length < 350;
      const isChromeNoise = /\b(edge|browser|sidebar|settings|profile|password|favorites)\b/i.test(combined) && !re.test(combined);
      const isSmallEnough = combined.length < 900;
      if ((hasExtension || hasSmallAttachmentLabel) && isInteractive && isSmallEnough && !isChromeNoise) {
        el.setAttribute('data-agent-zero-attachment-hit', String(hits.length));
        hits.push({
          index: hits.length,
          text: combined.slice(0, 700),
          tag: el.tagName,
          role,
          href: el.getAttribute('href') || '',
          hasExtension
        });
      }
    }
    hits.sort((a, b) => Number(b.hasExtension) - Number(a.hasExtension) || a.text.length - b.text.length);
    return hits;
  }, { pattern });
}

async function clickAttachmentHit(page, index) {
  await page.evaluate(({ index }) => {
    const el = document.querySelector(`[data-agent-zero-attachment-hit="${index}"]`);
    if (!el) throw new Error(`attachment hit ${index} disappeared`);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    el.click();
  }, { index });
}

async function clickDownloadControl(page) {
  const controls = [
    page.getByRole('button', { name: /download|herunterladen/i }).first(),
    page.getByText(/download|herunterladen/i).first(),
    page.locator('[aria-label*="Download" i], [title*="Download" i], [aria-label*="Herunterladen" i], [title*="Herunterladen" i]').first()
  ];
  for (const control of controls) {
    if (await control.isVisible({ timeout: 2000 }).catch(() => false)) {
      await control.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function saveDownload(download, downloadDir) {
  const suggested = download.suggestedFilename();
  const safeName = suggested.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || `attachment-${Date.now()}`;
  const target = path.join(downloadDir, safeName);
  await download.saveAs(target);
  return target;
}

function itemIdFromOwaUrl(value) {
  const match = String(value || '').match(/\/id\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function attachmentFileName(attachment) {
  return attachment?.Name || attachment?.name || attachment?.FileName || attachment?.fileName || '';
}

async function owaFetchJson(page, url) {
  return await page.evaluate(async ({ url }) => {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') || '',
      text: json ? null : text.slice(0, 1000),
      json
    };
  }, { url });
}

function scoreRestMessage(message, cfg) {
  const text = compact([
    message.Subject,
    message.subject,
    message.From?.EmailAddress?.Name,
    message.From?.EmailAddress?.Address,
    message.from?.emailAddress?.name,
    message.from?.emailAddress?.address,
    message.DateTimeReceived,
    message.dateTimeReceived,
    message.ReceivedDateTime,
    message.receivedDateTime
  ].filter(Boolean).join(' ')).toLowerCase();
  const subjectTerms = compact(cfg.subject).split(/\s+/).filter(term => term.length >= 5);
  let score = 0;
  for (const term of subjectTerms) if (text.includes(term.toLowerCase())) score += 2;
  for (const term of dateTerms(cfg.date)) if (text.includes(term.toLowerCase())) score += 1;
  if (cfg.sender) {
    for (const term of compact(cfg.sender).split(/\s+/).filter(term => term.length >= 4)) {
      if (text.includes(term.toLowerCase())) score += 3;
    }
  }
  if (message.HasAttachments || message.hasAttachments) score += 5;
  return score;
}

async function tryOwaRestAttachmentDownload(page, cfg) {
  const origin = new URL(page.url()).origin;
  const itemId = itemIdFromOwaUrl(page.url()) || itemIdFromOwaUrl(cfg.messageUrl);
  const attempts = [];
  if (!itemId) return { ok: false, reason: 'No OWA item id in current URL.', attempts };

  const select = '$select=Id,Subject,From,DateTimeReceived,HasAttachments,ConversationId';
  const messageUrl = `${origin}/api/v2.0/me/messages/${encodeURIComponent(itemId)}?${select}`;
  const messageResponse = await owaFetchJson(page, messageUrl);
  attempts.push({ url: messageUrl, status: messageResponse.status, ok: messageResponse.ok, text: messageResponse.text });
  if (!messageResponse.ok || !messageResponse.json) {
    return { ok: false, reason: 'OWA REST message lookup failed.', attempts };
  }

  const seed = messageResponse.json;
  let messages = [seed];
  const conversationId = seed.ConversationId || seed.conversationId;
  if (conversationId) {
    const escaped = String(conversationId).replace(/'/g, "''");
    const filter = encodeURIComponent(`ConversationId eq '${escaped}'`);
    const conversationUrl = `${origin}/api/v2.0/me/messages?$filter=${filter}&${select}&$top=25`;
    const conversationResponse = await owaFetchJson(page, conversationUrl);
    attempts.push({ url: conversationUrl, status: conversationResponse.status, ok: conversationResponse.ok, text: conversationResponse.text });
    const values = conversationResponse.json?.value || conversationResponse.json?.Value;
    if (conversationResponse.ok && Array.isArray(values) && values.length) messages = values;
  }

  messages = messages
    .map(message => ({ message, score: scoreRestMessage(message, cfg) }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.message);

  const saved = [];
  const pattern = new RegExp(cfg.attachmentNamePattern, 'i');
  for (const message of messages) {
    if (!(message.HasAttachments || message.hasAttachments)) continue;
    const id = message.Id || message.id;
    if (!id) continue;
    const attachmentsUrl = `${origin}/api/v2.0/me/messages/${encodeURIComponent(id)}/attachments`;
    const attachmentsResponse = await owaFetchJson(page, attachmentsUrl);
    attempts.push({ url: attachmentsUrl, status: attachmentsResponse.status, ok: attachmentsResponse.ok, text: attachmentsResponse.text });
    const attachments = attachmentsResponse.json?.value || attachmentsResponse.json?.Value || [];
    for (const attachment of attachments) {
      const name = attachmentFileName(attachment);
      const contentType = attachment.ContentType || attachment.contentType || '';
      const contentBytes = attachment.ContentBytes || attachment.contentBytes || '';
      const isFile = /fileattachment/i.test(attachment['@odata.type'] || attachment.Type || attachment.type || '') || Boolean(contentBytes);
      if (!isFile) continue;
      if (!pattern.test(name) && !/(pdf|powerpoint|presentation|word|excel|spreadsheet)/i.test(contentType)) continue;
      if (!contentBytes) {
        attempts.push({ attachment: name, status: 'no-contentBytes', ok: false });
        continue;
      }
      const safeName = (name || `attachment-${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      const target = path.join(cfg.downloadDir, safeName);
      fs.writeFileSync(target, Buffer.from(contentBytes, 'base64'));
      saved.push({
        savedPath: target,
        name,
        contentType,
        message: {
          subject: message.Subject || message.subject || '',
          from: message.From?.EmailAddress?.Name || message.from?.emailAddress?.name || '',
          date: message.DateTimeReceived || message.dateTimeReceived || message.ReceivedDateTime || message.receivedDateTime || ''
        }
      });
    }
    if (saved.length) break;
  }

  if (!saved.length) return { ok: false, reason: 'No matching OWA REST file attachment with content bytes.', attempts, messages: messages.slice(0, 5) };
  return { ok: true, saved, attempts };
}

async function downloadAttachment(page, cfg) {
  const session = await page.context().newCDPSession(page);
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: cfg.downloadDir,
    eventsEnabled: true
  }).catch(async () => {
    await session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: cfg.downloadDir }).catch(() => {});
  });

  await expandReadOnlyConversation(page);
  const hits = await findAttachmentElements(page, cfg.attachmentNamePattern);
  if (!hits.length) {
    const rest = await tryOwaRestAttachmentDownload(page, cfg).catch(error => ({ ok: false, reason: String(error), attempts: [] }));
    if (rest.ok && rest.saved.length) {
      return {
        hit: { source: 'owa-rest', attempts: rest.attempts, attachment: rest.saved[0] },
        savedPath: rest.saved[0].savedPath
      };
    }
    const debug = await debugPageSnapshot(page, cfg.attachmentNamePattern);
    debug.owaRest = rest;
    const error = new Error(`No visible attachment matched ${cfg.attachmentNamePattern}. Debug: ${JSON.stringify(debug).slice(0, 2500)}`);
    error.owaRest = rest;
    throw error;
  }

  for (const hit of hits.slice(0, 6)) {
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await clickAttachmentHit(page, hit.index);
    let download = await downloadPromise;
    if (!download) {
      await page.waitForTimeout(2500);
      const secondDownloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const clickedDownload = await clickDownloadControl(page);
      download = clickedDownload ? await secondDownloadPromise : null;
    }
    if (download) {
      const savedPath = await saveDownload(download, cfg.downloadDir);
      return { hit, savedPath };
    }
  }

  const rest = await tryOwaRestAttachmentDownload(page, cfg).catch(error => ({ ok: false, reason: String(error), attempts: [] }));
  if (rest.ok && rest.saved.length) {
    return {
      hit: { source: 'owa-rest', attempts: rest.attempts, attachment: rest.saved[0] },
      savedPath: rest.saved[0].savedPath
    };
  }
  const debug = await debugPageSnapshot(page, cfg.attachmentNamePattern);
  debug.owaRest = rest;
  const error = new Error(`Attachment controls were found, but no download event completed. Hits: ${JSON.stringify(hits.slice(0, 6))}. Debug: ${JSON.stringify(debug).slice(0, 2500)}`);
  error.owaRest = rest;
  throw error;
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const debug = {};
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.port}`, { timeout: 30000 });
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find(p => /outlook\.office\.com|login\.microsoftonline\.com/i.test(p.url())) || context.pages()[0] || await context.newPage();
  const deadline = Date.now() + cfg.timeoutMs;

  if (!/outlook\.office\.com/i.test(page.url())) {
    await page.goto(cfg.messageUrl || cfg.owaUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  debug.owaReady = await waitForOwaReady(page, Math.max(30000, Math.min(120000, deadline - Date.now())));
  let query = null;
  let message = { directUrl: null };
  if (cfg.messageUrl) {
    if (page.url() !== cfg.messageUrl) {
      await page.goto(cfg.messageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
    }
    message = { directUrl: cfg.messageUrl, currentUrl: page.url() };
  } else {
    query = await runSearch(page, cfg);
    debug.query = query;
    debug.expandedSearchRows = await expandSearchConversationRows(page, cfg);
    message = await scoreAndClickMessage(page, cfg);
  }
  debug.message = message;
  debug.openedMessageView = await openSelectedMessageView(page, cfg);
  await expandReadOnlyConversation(page);
  debug.beforeDownload = await debugPageSnapshot(page, cfg.attachmentNamePattern);
  const debugScreenshotPath = path.join(cfg.downloadDir, 'debug-before-download.png');
  await page.screenshot({ path: debugScreenshotPath, fullPage: false }).catch(() => {});
  debug.screenshot = fs.existsSync(debugScreenshotPath) ? debugScreenshotPath : null;
  let download;
  try {
    download = await downloadAttachment(page, cfg);
  } catch (error) {
    debug.afterFailure = await debugPageSnapshot(page, cfg.attachmentNamePattern);
    if (error && error.owaRest) debug.afterFailure.owaRest = error.owaRest;
    const failureScreenshotPath = path.join(cfg.downloadDir, 'debug-failure.png');
    await page.screenshot({ path: failureScreenshotPath, fullPage: false }).catch(() => {});
    debug.failureScreenshot = fs.existsSync(failureScreenshotPath) ? failureScreenshotPath : null;
    fs.writeFileSync(cfg.manifestPath, JSON.stringify({
      ok: false,
      subject: cfg.subject,
      date: cfg.date,
      sender: cfg.sender || null,
      query,
      message,
      owaUrl: page.url(),
      debug,
      error: error && error.stack ? error.stack : String(error)
    }, null, 2), 'utf8');
    throw error;
  }
  const bodyText = compact(await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 2000);

  const manifest = {
    ok: true,
    subject: cfg.subject,
    date: cfg.date,
    sender: cfg.sender || null,
    query,
    message,
    attachment: download.hit,
    downloadedFiles: [download.savedPath],
    owaUrl: page.url(),
    bodyTextSample: bodyText,
    debug
  };
  fs.writeFileSync(cfg.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await browser.close().catch(() => {});
})().catch(error => {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let existing = {};
  try {
    if (fs.existsSync(cfg.manifestPath)) existing = JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  } catch {}
  const manifest = {
    ...existing,
    ok: false,
    error: error && error.stack ? error.stack : String(error)
  };
  fs.writeFileSync(cfg.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  process.exit(1);
});
'@
  Set-Content -LiteralPath $nodeScriptPath -Value $nodeScript -Encoding UTF8

  $node = Get-Command node -ErrorAction Stop
  & $node.Source $nodeScriptPath $configPath
  if ($LASTEXITCODE -ne 0) {
    $manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
    $message = if ($manifest -and $manifest.error) { $manifest.error } else { "OWA CDP worker failed with exit code $LASTEXITCODE" }
    throw $message
  }

  $manifestObj = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $textFiles = @()
  foreach ($file in @($manifestObj.downloadedFiles)) {
    $fileFull = ConvertTo-FullPath $file
    if (-not (Test-IsPathInside -Child $fileFull -Parent $downloadFull)) {
      throw "Downloaded file escaped run directory: $fileFull"
    }
    if ($fileFull -match '\.pdf$') {
      $textPath = "$fileFull.txt"
      $extract = Convert-PdfToText -PdfPath $fileFull -TextPath $textPath
      $textFiles += $extract.textPath
    }
  }

  $result = @{
    ok = $true
    runId = $RunId
    edgePid = $edge.Id
    debugPort = $port
    downloadDir = $downloadFull
    manifestPath = $manifestPath
    downloadedFiles = @($manifestObj.downloadedFiles)
    textFiles = $textFiles
  }
  Write-Result $result
} finally {
  Remove-Item -LiteralPath $nodeScriptPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
  Stop-OwnedEdge -Process $edge -ProfileDir $startedProfile -Keep:$KeepBrowserOpen
}
