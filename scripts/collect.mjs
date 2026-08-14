import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const DOCS = path.join(ROOT, "docs");
const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const TOKEN = process.env.GH_TOKEN;
const TOP = 10;
const CANDIDATES = 30;
const CHINESE_RATIO = 0.12;
const MIN_HAN = 40;

if (!TOKEN) throw new Error("GH_TOKEN is missing. Add it in Settings > Secrets and variables > Actions.");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const text = (value = "") => value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

async function get(url, accept = "application/vnd.github+json") {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: accept, Authorization: "Bearer " + TOKEN, "User-Agent": "GitHub-Monitoring/0.1", "X-GitHub-Api-Version": "2022-11-28" } });
      if (response.ok) return response;
      const body = await response.text();
      if (response.status < 500 && response.status !== 429) throw new Error(response.status + " " + body.slice(0, 160));
      last = new Error(response.status + " " + response.statusText);
    } catch (error) {
      last = error;
      if (attempt === 3) break;
    }
    await wait(attempt * 900);
  }
  throw last;
}

function parseTrending(html) {
  const rows = html.match(/<article[\s\S]*?<\/article>/g) || [];
  const result = [];
  for (const row of rows) {
    const repo = row.match(/href="\/(?!features|topics|sponsors)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/);
    if (!repo) continue;
    const visible = text(row);
    const hot = visible.match(/([\d,]+)\s+stars today/i);
    const lang = row.match(/itemprop="programmingLanguage"[^>]*>\s*([^<]+)/);
    const desc = row.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    result.push({ fullName: repo[1], todayStars: hot ? Number(hot[1].replace(/,/g, "")) : null, language: lang ? text(lang[1]) : "", description: desc ? text(desc[1]) : "" });
  }
  return [...new Map(result.map((item) => [item.fullName.toLowerCase(), item])).values()].slice(0, CANDIDATES);
}

async function getTrending(chinese) {
  const url = chinese ? "https://github.com/trending?since=daily&spoken_language_code=zh" : "https://github.com/trending?since=daily";
  const page = await get(url, "text/html");
  const candidates = parseTrending(await page.text());
  if (!candidates.length) throw new Error("Trending page returned no parseable repositories.");
  return candidates;
}

function chineseStats(source) {
  const clean = source.replace(/\`\`\`[\s\S]*?\`\`\`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[\[\]_*#|\`~>]/g, " ");
  const han = (clean.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  return { han, ratio: han / Math.max(1, han + latin) };
}

async function enrich(candidate, checkChinese) {
  const api = await get("https://api.github.com/repos/" + candidate.fullName);
  const repo = await api.json();
  let readme = "";
  if (checkChinese) {
    try {
      const response = await get("https://api.github.com/repos/" + candidate.fullName + "/readme");
      const payload = await response.json();
      readme = Buffer.from(payload.content || "", "base64").toString("utf8").slice(0, 24000);
    } catch {}
  }
  const signal = chineseStats((repo.description || "") + "\n" + readme);
  return {
    fullName: repo.full_name, url: repo.html_url, stars: repo.stargazers_count, forks: repo.forks_count,
    language: repo.language || candidate.language || "未标注", description: repo.description || candidate.description || "",
    createdAt: repo.created_at, todayStars: candidate.todayStars,
    chineseProject: signal.han >= MIN_HAN && signal.ratio >= CHINESE_RATIO
  };
}

async function buildBoard(candidates, chinese) {
  const result = [];
  for (const candidate of candidates) {
    try {
      const repo = await enrich(candidate, chinese);
      if (!chinese || repo.chineseProject) result.push(repo);
    } catch (error) {
      console.warn("Skipping " + candidate.fullName + ": " + error.message);
    }
  }
  return result.sort((a, b) => (b.todayStars ?? -1) - (a.todayStars ?? -1) || b.stars - a.stars).slice(0, TOP).map((repo, index) => ({ ...repo, rank: index + 1 }));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temp, file);
}

function projectCard(repo) {
  const age = repo.createdAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(repo.createdAt)) : "未提供";
  const hot = repo.todayStars == null ? "未提供" : "+" + repo.todayStars.toLocaleString();
  return '<article class="card"><b class="rank">#' + repo.rank + '</b><div><a href="' + esc(repo.url) + '" target="_blank" rel="noreferrer">' + esc(repo.fullName) + '</a><p>' + esc(repo.description || "暂无仓库简介") + '</p><div class="metrics"><span>Star <strong>' + repo.stars.toLocaleString() + '</strong></span><span>Fork <strong>' + repo.forks.toLocaleString() + '</strong></span><span>今日热度 <strong class="hot">' + hot + '</strong></span><span>' + esc(repo.language) + '</span><span>创建于 ' + age + '</span></div><em>' + (repo.chineseProject ? "中文项目" : "公开项目") + '</em></div></article>';
}

function section(title, subtitle, board, source) {
  const warning = source.fallback ? '<p class="warning">本来源本次更新失败，展示上一次成功数据：' + esc(source.error) + '</p>' : '<p class="subtitle">' + subtitle + '</p>';
  return '<section><h2>' + title + '</h2>' + warning + (board.length ? board.map(projectCard).join("") : '<p class="empty">本次没有满足规则的项目。</p>') + '</section>';
}

function html(report) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub 每日情报 · ' + report.date + '</title><style>body{margin:0;background:#f8fafc;color:#101828;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{max-width:960px;margin:auto;padding:42px 20px 70px}header{border-bottom:1px solid #e4e7ec;padding-bottom:24px}h1{margin:0 0 8px;font-size:32px}h2{margin:36px 0 6px;font-size:22px}.meta,.subtitle{margin:0;color:#667085}.card{display:flex;gap:16px;margin-top:12px;padding:18px;background:#fff;border:1px solid #e4e7ec;border-radius:14px}.rank{min-width:38px;color:#155eef;font-size:20px}.card a{font-size:17px;font-weight:750;color:#155eef;text-decoration:none;word-break:break-all}.card p{margin:8px 0 12px;color:#475467;line-height:1.5}.metrics{display:flex;flex-wrap:wrap;gap:10px 20px;font-size:13px}.metrics span{color:#667085}.metrics strong{color:#101828}.metrics .hot{color:#b42318}.card em{display:inline-block;margin-top:12px;padding:3px 8px;border-radius:999px;background:#eff4ff;color:#175cd3;font-style:normal;font-size:12px}.warning{padding:10px 12px;border:1px solid #fedf89;border-radius:8px;background:#fffaeb;color:#b54708}.empty{padding:16px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#667085}footer{margin-top:38px;padding-top:20px;border-top:1px solid #e4e7ec;color:#667085;font-size:13px}@media(max-width:560px){main{padding:28px 13px}.card{padding:14px;gap:10px}}</style></head><body><main><header><h1>GitHub 每日情报</h1><p class="meta">' + report.date + ' · 采集于 ' + report.collectedAtShanghai + '（北京时间）</p><p class="meta">排名由 GitHub Trending 的当日新增 Star 信号决定，AI 不参与排名。</p></header>' + section("今日全站热门 Top 10", "来源：GitHub Trending（daily）+ GitHub API 真实元数据", report.boards.full, report.sources.full) + section("今日中文热门 Top 10", "来源：GitHub Trending 中文候选；README/简介中文有效文本比例至少 12%，且至少 40 个中文字符", report.boards.chinese, report.sources.chinese) + '<footer>数据范围：公开 GitHub 数据。历史日报：<a href="./history/' + report.date + '.json">' + report.date + '</a></footer></main></body></html>';
}

const previous = await readJson(path.join(DATA, "latest.json"), null);
const boards = { full: [], chinese: [] };
const sources = { full: { ok: false, fallback: false, error: null }, chinese: { ok: false, fallback: false, error: null } };

for (const [name, chinese] of [["full", false], ["chinese", true]]) {
  try {
    boards[name] = await buildBoard(await getTrending(chinese), chinese);
    sources[name].ok = true;
  } catch (error) {
    sources[name].error = error.message;
    if (previous?.boards?.[name]?.length) {
      boards[name] = previous.boards[name];
      sources[name].fallback = true;
    }
  }
}
if (!sources.full.ok && !sources.chinese.ok && !previous) throw new Error("Both sources failed; no successful report was overwritten.");

const report = {
  schemaVersion: 1, phase: 1, date: DATE, collectedAt: new Date().toISOString(),
  collectedAtShanghai: new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium", hour12: false }).format(new Date()),
  sources, boards,
  rules: { fullSort: "Trending daily 新增 Star 降序", chineseSort: "Trending 中文候选的 daily 新增 Star 降序", chineseRatioThreshold: CHINESE_RATIO, minChineseCharacters: MIN_HAN }
};
await saveJson(path.join(DATA, "latest.json"), report);
await saveJson(path.join(DOCS, "history", DATE + ".json"), report);
await mkdir(DOCS, { recursive: true });
await writeFile(path.join(DOCS, "index.html"), html(report), "utf8");
const historyFile = path.join(DATA, "history", "index.json");
const history = await readJson(historyFile, []);
await saveJson(historyFile, [{ date: DATE, collectedAt: report.collectedAt, path: "history/" + DATE + ".json" }, ...history.filter((item) => item.date !== DATE)]);
console.log("Generated " + DATE + ": " + boards.full.length + " global, " + boards.chinese.length + " Chinese projects.");
