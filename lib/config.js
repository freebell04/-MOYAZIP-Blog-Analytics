// 사용자별 설정: 네이버 블로그 아이디, 블로그 이름.
// 우선순위: 환경변수(실행하기.bat) > data/app-config.json (처음 실행 때 설정 화면에서 저장)
const path = require("path");
const fs = require("fs");

const CONFIG_PATH = path.join(__dirname, "..", "data", "app-config.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const blogId = () => (process.env.NAVER_BLOG_ID || load().blogId || "").trim();
const blogName = () => (process.env.NAVER_BLOG_NAME || load().blogName || "내 블로그").trim();
const isConfigured = () => !!blogId();

function save({ blogId: id, blogName: name }) {
  const clean = String(id || "").trim().replace(/^https?:\/\/(m\.)?blog\.naver\.com\//, "").split(/[/?#]/)[0];
  if (!/^[a-z0-9_-]{3,30}$/i.test(clean)) throw new Error("네이버 블로그 아이디를 확인해주세요 (blog.naver.com/ 뒤에 오는 영문·숫자).");
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ blogId: clean, blogName: String(name || "").trim() || clean, savedAt: new Date().toISOString() }, null, 2));
  return { blogId: clean };
}

module.exports = { blogId, blogName, isConfigured, save };
