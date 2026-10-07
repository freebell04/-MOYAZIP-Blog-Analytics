// 창 배치: 대시보드(이 프로그램 화면)와 자동화용 크롬을 화면 왼쪽/오른쪽 반반으로 나란히 놓는다.
//  - AI(ChatGPT 등)와 대화할 때: 왼쪽 = 대시보드(안내 창), 오른쪽 = AI 채팅 크롬
//  - 블로그에 글이 자동으로 써질 때: 왼쪽 = 대시보드(진행 상황), 오른쪽 = 글쓰기 크롬
// 윈도우 전용(PowerShell + user32). 대시보드 창은 "창 제목에 '네이버 블로그 자동화'가 보이는" 브라우저 창을 찾는다
// (그 탭이 맨 앞 탭이 아니면 못 찾을 수 있고, 그땐 크롬만 오른쪽 반으로 옮긴다). 실패해도 아무 일도 없다.
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "data", "window-layout.ps1");
const TITLE_KEY = "네이버 블로그 자동화|이웃 소통|성과 통계"; // 이 프로그램 화면들의 창 제목 (| 로 구분)

const PS = `param([string]$Mode, [string]$Profile, [string]$TitleKey)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class NbhWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
}
"@
function Raise($h) {
  [NbhWin]::ShowWindow($h, 9) | Out-Null
  [NbhWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [NbhWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [NbhWin]::SetForegroundWindow($h) | Out-Null
}
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$cp = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Profile) -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
$chr = $null
if ($cp) { $chr = Get-Process -Id $cp.ProcessId -ErrorAction SilentlyContinue }
$keys = $TitleKey -split "\|"
$dash = Get-Process | Where-Object { $p = $_; $_.MainWindowHandle -ne 0 -and ($keys | Where-Object { $p.MainWindowTitle -like "*$_*" }) -and ((-not $chr) -or $_.Id -ne $chr.Id) } | Select-Object -First 1
$half = [int]($wa.Width / 2)
if ($Mode -eq 'info') { "dash=" + [bool]$dash + " chrome=" + [bool]($chr -and $chr.MainWindowHandle -ne 0); exit }
if ($Mode -eq 'dashboard') { if ($dash) { Raise $dash.MainWindowHandle }; exit }
$left = ($Mode -eq 'splitleft')
$cx = if ($left) { $wa.X } else { $wa.X + $half }
$dx = if ($left) { $wa.X + $half } else { $wa.X }
if ($chr -and $chr.MainWindowHandle -ne 0) {
  [NbhWin]::ShowWindow($chr.MainWindowHandle, 9) | Out-Null
  [NbhWin]::SetWindowPos($chr.MainWindowHandle, [IntPtr]::Zero, $cx, $wa.Y, $wa.Width - $half, $wa.Height, 0x0040) | Out-Null
}
if ($dash) {
  [NbhWin]::ShowWindow($dash.MainWindowHandle, 9) | Out-Null
  [NbhWin]::SetWindowPos($dash.MainWindowHandle, [IntPtr]::Zero, $dx, $wa.Y, $half, $wa.Height, 0x0040) | Out-Null
}
# 둘 다 보이게 한 뒤, 작업할 쪽(크롬)을 맨 앞으로
if ($chr -and $chr.MainWindowHandle -ne 0) { Raise $chr.MainWindowHandle }
`;

function ensureScript() {
  fs.mkdirSync(path.dirname(SCRIPT), { recursive: true });
  // 한글이 들어 있으니 BOM을 붙여 PowerShell 5.1이 UTF-8로 읽게 한다
  const want = "﻿" + PS;
  let have = "";
  try { have = fs.readFileSync(SCRIPT, "utf-8"); } catch {}
  if (have !== want) fs.writeFileSync(SCRIPT, want, "utf-8");
}

function run(mode) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve("");
    try {
      ensureScript();
      const profile = path.join(__dirname, "..", "data", "chrome-profile");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Mode", mode, "-Profile", profile, "-TitleKey", TITLE_KEY],
        { timeout: 15000, windowsHide: true },
        (err, stdout) => resolve(err ? "" : String(stdout || "").trim())
      );
    } catch {
      resolve("");
    }
  });
}

let lastSplit = 0;
/** 대시보드(왼쪽)와 자동화 크롬(오른쪽)을 반반으로 나란히 놓는다. 너무 자주 하지 않게 2초 간격 */
async function split(mode = "split") {
  if (Date.now() - lastSplit < 2000) return;
  lastSplit = Date.now();
  await run(mode);
}
/** 이 프로그램 화면을 앞으로 */
const dashboardToFront = () => run("dashboard");
/** 몇 초 뒤(크롬 창이 뜬 다음)에 한 번씩 배치한다 */
function splitSoon(delays = [2500, 9000], mode = "split") {
  for (const d of delays) setTimeout(() => split(mode).catch(() => {}), d);
}
/** 이웃 글 보러 갈 때: 이웃 글(크롬)은 왼쪽, 이 프로그램 화면은 오른쪽 */
const splitLeftSoon = (delays = [800, 3500]) => splitSoon(delays, "splitleft");

module.exports = { split, splitSoon, splitLeftSoon, dashboardToFront, info: () => run("info") };
