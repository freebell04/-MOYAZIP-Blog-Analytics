// Claude Code CLI(-p 모드)를 서브프로세스로 호출하는 래퍼.
// API 종량제가 아니라 사용자가 이미 로그인한 Claude Code 구독 세션을 그대로 사용한다.
const { spawn } = require("child_process");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "npx";
const CLAUDE_ARGS_PREFIX = process.env.CLAUDE_BIN ? [] : ["--yes", "@anthropic-ai/claude-code"];

/**
 * @param {string} prompt
 * @param {{cwd?: string, timeoutMs?: number}} opts
 * @returns {Promise<string>} 모델의 텍스트 응답 (stdout)
 */
function askClaude(prompt, opts = {}) {
  const { cwd = process.cwd(), timeoutMs = 180000 } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      ...CLAUDE_ARGS_PREFIX,
      "-p",
      prompt,
      "--output-format",
      "text",
      // -p(비대화형) 모드에서는 터미널이 없어 권한 확인 프롬프트가 뜰 수 없으므로,
      // 로컬 개인 자동화라는 전제 하에 권한 확인을 건너뜀.
      "--dangerously-skip-permissions",
    ];
    // stdin을 명시적으로 닫아서 "표준입력 기다리는 중" 경고/지연이 안 생기게 한다
    // (이게 진짜 에러(로그인 만료 등)를 화면에서 가려버리는 문제가 있었음).
    const child = spawn(CLAUDE_BIN, args, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });

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
 * 응답에서 JSON만 추출해서 파싱한다. 모델이 설명 텍스트를 덧붙여도 최대한 복구한다.
 */
function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("응답에서 JSON을 찾지 못했습니다: " + text.slice(0, 200));
  return JSON.parse(match[0]);
}

module.exports = { askClaude, extractJson };
