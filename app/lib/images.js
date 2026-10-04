// 네이버 이미지 검색 크롤링 + 다운로드 + Claude 비전 판단(적합성)
const fs = require("fs");
const path = require("path");
const https = require("https");
// Playwright는 크고(불러오는 데 0.2초) 켤 때는 필요 없어서, 처음 쓰는 순간에 불러온다
const chromium = new Proxy({}, { get: (_, k) => { const c = require("playwright").chromium; const v = c[k]; return typeof v === "function" ? v.bind(c) : v; } });
const { askClaude, extractJson } = require("./claude");

const IMG_DIR = path.join(__dirname, "..", "data", "images");
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

async function searchImageUrls(query, limit = 6) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`https://search.naver.com/search.naver?where=image&query=${encodeURIComponent(query)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1000);

  const urls = await page.$$eval("img._image, .image_tile img, .tile_item img", (imgs) =>
    imgs.map((img) => img.src || img.getAttribute("data-src")).filter(Boolean)
  );

  await browser.close();
  return [...new Set(urls)].slice(0, limit);
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`이미지 다운로드 실패 (${res.statusCode}): ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

/**
 * 검색어로 이미지를 찾아 다운로드하고, Claude에게 글 주제와 어울리는지 판단시켜
 * 적합도 순으로 정렬된 후보 목록을 돌려준다.
 * @param {string} query 이미지 검색어
 * @param {string} contextTopic 글 주제/문맥 (적합성 판단 근거)
 */
async function findAndJudgeImages(query, contextTopic) {
  const urls = await searchImageUrls(query);
  const candidates = [];

  for (let i = 0; i < urls.length; i++) {
    const ext = path.extname(new URL(urls[i]).pathname).split("?")[0] || ".jpg";
    const destPath = path.join(IMG_DIR, `${Date.now()}_${i}${ext}`);
    try {
      await download(urls[i], destPath);
      candidates.push({ path: destPath, webPath: "/images/" + path.basename(destPath), url: urls[i] });
    } catch (e) {
      // 다운로드 실패한 이미지는 건너뜀
    }
  }

  const judged = [];
  for (const c of candidates) {
    try {
      const prompt =
        `다음 이미지 파일을 확인해줘: ${c.path}\n` +
        `이 블로그 글 주제와 어울리는 사진인지 판단해줘: "${contextTopic}"\n` +
        `아래 JSON 형식으로만 답해: {"score": 0~10 숫자, "reason": "한 줄 이유"}`;
      const res = await askClaude(prompt, { timeoutMs: 60000 });
      const { score, reason } = extractJson(res);
      judged.push({ ...c, score, reason });
    } catch (e) {
      judged.push({ ...c, score: 0, reason: "판단 실패: " + e.message });
    }
  }

  judged.sort((a, b) => b.score - a.score);
  return judged;
}

module.exports = { searchImageUrls, findAndJudgeImages, IMG_DIR };
