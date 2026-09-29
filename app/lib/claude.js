// Claude Code CLI(-p 모드)를 서브프로세스로 호출하는 래퍼.
// API 종량제가 아니라 사용자가 이미 로그인한 Claude Code 구독 세션을 그대로 사용한다.
const { spawn } = require("child_process");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "npx";
const CLAUDE_ARGS_PREFIX = process.env.CLAUDE_BIN ? [] : ["--yes", "@anthropic-ai/claude-code"];

// Claude Code 데스크톱 앱과 터미널용 Claude(CLI)는 로그인이 따로라서, CLI는 한 번 따로 로그인해야 한다.
const NOT_LOGGED_IN = "CLAUDE_NOT_LOGGED_IN";

/**
 * @param {string} prompt
 * @param {{cwd?: string, timeoutMs?: number}} opts
 * @returns {Promise<string>} 모델의 텍스트 응답 (stdout)
 */
function askClaude(prompt, opts = {}) {
  const { cwd = process.cwd(), timeoutMs = 180000 } = opts;

  return new Promise((resolve, reject) => {
    // 프롬프트는 명령줄 인자가 아니라 표준입력으로 넘긴다.
    // (Windows에선 npx가 .cmd라 shell을 거치는데, 여러 줄·따옴표·&·|·% 가 든 긴 프롬프트가
    //  명령줄로 넘어가면 cmd가 잘라먹거나 다른 명령으로 해석해버린다)
    const args = [
      ...CLAUDE_ARGS_PREFIX,
      "-p",
      "--output-format",
      "text",
      // -p(비대화형) 모드에서는 터미널이 없어 권한 확인 프롬프트가 뜰 수 없으므로,
      // 로컬 개인 자동화라는 전제 하에 권한 확인을 건너뜀.
      "--dangerously-skip-permissions",
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {}); // 프로세스가 먼저 끝나버려도(로그인 안 됨 등) 서버가 죽지 않게
    child.stdin.end(prompt, "utf8");

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude CLI timeout"));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" / ") || "(빈 출력)";
        if (/not logged in|please run \/login/i.test(detail)) {
          const e = new Error("AI 글쓰기용 Claude에 아직 로그인하지 않았어요. [Claude 로그인 창 열기]를 눌러 처음 한 번만 로그인해주세요.");
          e.code = NOT_LOGGED_IN;
          reject(e);
          return;
        }
        reject(new Error(`Claude CLI exited with code ${code}: ${detail}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * CLI 로그인용 터미널 창을 띄운다. 처음 실행하면 Claude가 로그인 방법을 물어보고 브라우저를 열어준다.
 * (로그인은 사용자가 직접 한다 — 여기선 창만 열어준다)
 */
function openLoginWindow() {
  if (process.platform !== "win32") throw new Error("Windows에서만 지원해요. 터미널에서 'npx @anthropic-ai/claude-code'를 실행해 로그인해주세요.");
  const cmd = process.env.CLAUDE_BIN ? `"${process.env.CLAUDE_BIN}"` : "npx --yes @anthropic-ai/claude-code";
  spawn("cmd.exe", ["/c", "start", '"Claude 로그인"', "cmd", "/k", `echo 로그인 방법을 고르고 브라우저에서 로그인한 뒤, 이 창은 닫아도 돼요. && ${cmd}`], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  }).unref();
}

/**
 * 응답에서 JSON만 추출해서 파싱한다. 모델이 설명 텍스트를 덧붙여도 최대한 복구한다.
 */
function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("응답에서 JSON을 찾지 못했습니다: " + text.slice(0, 200));
  return JSON.parse(match[0]);
}

module.exports = { askClaude, extractJson, openLoginWindow, NOT_LOGGED_IN };
