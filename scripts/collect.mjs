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

async function searchCandidates(query, sort = "stars", perPage = 25) {
  const response = await get("https://api.github.com/search/repositories?q=" + encodeURIComponent(query) + "&sort=" + sort + "&order=desc&per_page=" + perPage);
  const payload = await response.json();
  return (payload.items || []).map((item) => ({ fullName: item.full_name, todayStars: null, language: item.language || "", description: item.description || "" }));
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
    createdAt: repo.created_at, todayStars: candidate.todayStars, topics: repo.topics || [],
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
  const starGrowth = repo.starGrowth24h == null ? "基线中" : (repo.starGrowth24h >= 0 ? "+" : "") + repo.starGrowth24h.toLocaleString();
  const forkGrowth = repo.forkGrowth24h == null ? "基线中" : (repo.forkGrowth24h >= 0 ? "+" : "") + repo.forkGrowth24h.toLocaleString();
  const category = repo.aiCategory ? '<em>' + esc(repo.aiCategory) + '</em>' : "";
  const estimate = repo.estimatedVelocity == null ? "" : '<span>Star/日 <strong>' + repo.estimatedVelocity.toLocaleString() + '</strong> <small>估算</small></span>';
  return '<article class="card"><b class="rank">#' + repo.rank + '</b><div><a href="' + esc(repo.url) + '" target="_blank" rel="noreferrer">' + esc(repo.fullName) + '</a><p>' + esc(repo.description || "暂无仓库简介") + '</p><div class="metrics"><span>Star <strong>' + repo.stars.toLocaleString() + '</strong></span><span>Fork <strong>' + repo.forks.toLocaleString() + '</strong></span><span>24h Star <strong class="hot">' + starGrowth + '</strong></span><span>24h Fork <strong>' + forkGrowth + '</strong></span><span>今日热度 <strong class="hot">' + hot + '</strong></span>' + estimate + '<span>' + esc(repo.language) + '</span><span>创建于 ' + age + '</span></div><em>' + (repo.chineseProject ? "中文项目" : "公开项目") + '</em>' + category + '</div></article>';
}

function section(title, subtitle, board, source) {
  const warning = source.fallback ? '<p class="warning">本来源本次更新失败，展示上一次成功数据：' + esc(source.error) + '</p>' : '<p class="subtitle">' + subtitle + '</p>';
  return '<section><h2>' + title + '</h2>' + warning + (board.length ? board.map(projectCard).join("") : '<p class="empty">本次没有满足规则的项目。</p>') + '</section>';
}

function html(report) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub 每日情报 · ' + report.date + '</title><style>body{margin:0;background:#f8fafc;color:#101828;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{max-width:960px;margin:auto;padding:42px 20px 70px}header{border-bottom:1px solid #e4e7ec;padding-bottom:24px}h1{margin:0 0 8px;font-size:32px}h2{margin:36px 0 6px;font-size:22px}.meta,.subtitle{margin:0;color:#667085}.card{display:flex;gap:16px;margin-top:12px;padding:18px;background:#fff;border:1px solid #e4e7ec;border-radius:14px}.rank{min-width:38px;color:#155eef;font-size:20px}.card a{font-size:17px;font-weight:750;color:#155eef;text-decoration:none;word-break:break-all}.card p{margin:8px 0 12px;color:#475467;line-height:1.5}.metrics{display:flex;flex-wrap:wrap;gap:10px 20px;font-size:13px}.metrics span{color:#667085}.metrics strong{color:#101828}.metrics .hot{color:#b42318}.card em{display:inline-block;margin-top:12px;padding:3px 8px;border-radius:999px;background:#eff4ff;color:#175cd3;font-style:normal;font-size:12px}.warning{padding:10px 12px;border:1px solid #fedf89;border-radius:8px;background:#fffaeb;color:#b54708}.empty{padding:16px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#667085}footer{margin-top:38px;padding-top:20px;border-top:1px solid #e4e7ec;color:#667085;font-size:13px}@media(max-width:560px){main{padding:28px 13px}.card{padding:14px;gap:10px}}</style></head><body><main><header><h1>GitHub 每日情报</h1><p class="meta">' + report.date + ' · 采集于 ' + report.collectedAtShanghai + '（北京时间）</p><p class="meta">排名由 GitHub Trending 的当日新增 Star 信号决定，AI 不参与排名。</p></header>' + section("今日全站热门 Top 10", "来源：GitHub Trending（daily）+ GitHub API 真实元数据", report.boards.full, report.sources.full) + section("今日中文热门 Top 10", "来源：GitHub Trending 中文候选；README/简介中文有效文本比例至少 12%，且至少 40 个中文字符", report.boards.chinese, report.sources.chinese) + '<section><h2>24h Star 增长 Top 10</h2><p class="subtitle">' + (report.baselineBuilding ? '正在建立首日基线；明日同一采集窗口后显示真实增长。' : '计算方式：当前 Star − 上一采集窗口 Star。') + '</p>' + (report.baselineBuilding ? '<p class="empty">正在建立首日基线</p>' : report.boards.starGrowth.map(projectCard).join("")) + '</section><section><h2>24h Fork 增长 Top 10</h2><p class="subtitle">' + (report.baselineBuilding ? '正在建立首日基线；明日同一采集窗口后显示真实增长。' : '计算方式：当前 Fork − 上一采集窗口 Fork。') + '</p>' + (report.baselineBuilding ? '<p class="empty">正在建立首日基线</p>' : report.boards.forkGrowth.map(projectCard).join("")) + '</section>' + '<section><h2>AI 项目增长 Top 10</h2><p class="subtitle">' + (report.baselineBuilding ? 'AI 候选池已建立；正在建立首日基线。' : 'AI 子类由关键词、主题、简介规则判定；按真实 24h Star 增量排序。') + '</p>' + (report.baselineBuilding ? '<p class="empty">正在建立首日基线</p>' : (report.boards.aiGrowth.length ? report.boards.aiGrowth.map(projectCard).join('') : '<p class="empty">无可比较 AI 项目</p>')) + '</section><section><h2>新项目爆发榜</h2><p class="subtitle">' + (report.baselineBuilding ? '创建不超过 5 天；没有前一日快照时按总 Star / 项目年龄估算，并标注“估算”；有快照后按真实 24h Star 增长排序。' : '创建不超过 5 天；优先真实 24h Star 增长；无前日快照时仅显示带“估算”标识的速度。') + '</p>' + (report.boards.newProjects.length ? report.boards.newProjects.map(projectCard).join('') : '<p class="empty">无满足条件的新项目</p>') + '</section>' + '<section><h2>自定义关键词增长榜</h2><p class="subtitle">' + (report.baselineBuilding ? '正在建立首日基线；预设关键词候选池已建立。' : '按预设关键词的 GitHub Search 候选池，以真实 24h Star 增量排序。') + '</p>' + Object.entries(report.boards.customKeywords || {}).map(([keyword, rows]) => '<h3>' + esc(keyword) + '</h3>' + (report.baselineBuilding ? '<p class="empty">正在建立首日基线</p>' : (rows.length ? rows.map(projectCard).join("") : '<p class="empty">无可比较项目</p>'))).join('') + '</section>' + '<footer>数据范围：公开 GitHub 数据。历史日报：<a href="./history/' + report.date + '.json">' + report.date + '</a></footer></main></body></html>';
}

const previous = await readJson(path.join(DATA, "latest.json"), null);
const snapshotIndexFile = path.join(DATA, "snapshots", "index.json");
const snapshotIndex = await readJson(snapshotIndexFile, []);
const priorSnapshotEntry = snapshotIndex.find((item) => item.date !== DATE);
const priorSnapshot = priorSnapshotEntry ? await readJson(path.join(DATA, "snapshots", priorSnapshotEntry.date + ".json"), null) : null;
const priorMetrics = new Map(Object.entries(priorSnapshot?.repositories || {}));
const boards = { full: [], chinese: [], starGrowth: [], forkGrowth: [] };
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

const discovery = { ai: [], new: [], custom: {}, errors: [] };
const enrichmentCache = new Map([...boards.full, ...boards.chinese].map((repo) => [repo.fullName.toLowerCase(), repo]));
async function enrichDiscovery(candidates, target) {
  const poolSeen = new Set();
  for (const candidate of candidates) {
    const key = candidate.fullName.toLowerCase();
    if (poolSeen.has(key)) continue;
    poolSeen.add(key);
    try {
      const repo = enrichmentCache.get(key) || await enrich(candidate, false);
      enrichmentCache.set(key, repo);
      target.push({ ...repo });
    } catch (error) { discovery.errors.push(candidate.fullName + ": " + error.message); }
  }
}
try {
  const aiCandidates = (await Promise.all(["topic:artificial-intelligence", "LLM in:name,description,readme", "MCP in:name,description,readme", "AI agent in:name,description,readme"].map((query) => searchCandidates(query, "stars", 100)))).flat();
  await enrichDiscovery(aiCandidates, discovery.ai);
} catch (error) { discovery.errors.push("AI 候选池: " + error.message); }
try {
  const createdAfter = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await enrichDiscovery(await searchCandidates("created:>" + createdAfter, "stars", 50), discovery.new);
} catch (error) { discovery.errors.push("新项目候选池: " + error.message); }
const keywordConfig = await readJson(path.join(ROOT, "config", "keywords.json"), { presets: ["Vue", "Python", "量化", "爬虫"], perKeywordCandidates: 25 });
for (const keyword of keywordConfig.presets || []) {
  const rows = [];
  try {
    await enrichDiscovery(await searchCandidates(keyword + " in:name,description,readme", "stars", keywordConfig.perKeywordCandidates || 25), rows);
    discovery.custom[keyword] = rows;
  } catch (error) { discovery.errors.push("关键词 " + keyword + ": " + error.message); discovery.custom[keyword] = []; }
}
const allRepositories = [...new Map([...boards.full, ...boards.chinese, ...discovery.ai, ...discovery.new, ...Object.values(discovery.custom).flat()].map((repo) => [repo.fullName, repo])).values()];
const aiTerms = { MCP: /\bmcp\b/i, RAG: /\brag\b|retrieval augmented/i, Agent: /\bagent\b/i, LLM: /\bllm\b|large language model|language model/i, "模型部署": /inference|serving|deployment/i, "开发工具": /copilot|coding|developer tool/i };
for (const repo of allRepositories) {
  const haystack = [repo.fullName, repo.description, ...(repo.topics || [])].join(" ");
  repo.aiCategory = Object.entries(aiTerms).find(([, rule]) => rule.test(haystack))?.[0] || null;
}
for (const repo of allRepositories) {
  const before = priorMetrics.get(repo.fullName);
  repo.starGrowth24h = before ? repo.stars - before.stars : null;
  repo.forkGrowth24h = before ? repo.forks - before.forks : null;
}
const growthRows = allRepositories.filter((repo) => repo.starGrowth24h !== null);
boards.starGrowth = growthRows.slice().sort((a, b) => b.starGrowth24h - a.starGrowth24h || b.stars - a.stars).slice(0, TOP).map((repo, index) => ({ ...repo, rank: index + 1 }));
boards.forkGrowth = growthRows.slice().sort((a, b) => b.forkGrowth24h - a.forkGrowth24h || b.forks - a.forks).slice(0, TOP).map((repo, index) => ({ ...repo, rank: index + 1 }));
const baselineBuilding = !priorSnapshot;
boards.aiGrowth = allRepositories.filter((repo) => repo.aiCategory && repo.starGrowth24h !== null).sort((a, b) => b.starGrowth24h - a.starGrowth24h).slice(0, TOP).map((repo, index) => ({ ...repo, rank: index + 1 }));
boards.newProjects = allRepositories.filter((repo) => repo.createdAt && Date.now() - new Date(repo.createdAt).getTime() <= 30 * 86400000).map((repo) => ({ ...repo, ageDays: Math.max(1, Math.ceil((Date.now() - new Date(repo.createdAt).getTime()) / 86400000)), estimatedVelocity: repo.starGrowth24h == null ? Math.round(repo.stars / Math.max(1, Math.ceil((Date.now() - new Date(repo.createdAt).getTime()) / 86400000)) * 10) / 10 : null })).sort((a, b) => (b.starGrowth24h ?? b.estimatedVelocity ?? 0) - (a.starGrowth24h ?? a.estimatedVelocity ?? 0)).slice(0, TOP).map((repo, index) => ({ ...repo, rank: index + 1 }));
boards.customKeywords = Object.fromEntries(Object.entries(discovery.custom).map(([keyword, candidates]) => [keyword, candidates.filter((repo) => repo.starGrowth24h !== null).sort((a, b) => b.starGrowth24h - a.starGrowth24h || b.stars - a.stars).slice(0, TOP).map((repo, index) => ({ ...repo, rank: index + 1 }))]));
const snapshot = { date: DATE, collectedAt: new Date().toISOString(), repositories: Object.fromEntries(allRepositories.map((repo) => [repo.fullName, { stars: repo.stars, forks: repo.forks }])) };
const report = {
  schemaVersion: 2, phase: 4, date: DATE, collectedAt: new Date().toISOString(),
  collectedAtShanghai: new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium", hour12: false }).format(new Date()),
  sources, boards, baselineBuilding, candidateCounts: { trending: boards.full.length + boards.chinese.length, aiSearch: discovery.ai.length, newProjectSearch: discovery.new.length, customKeywordSearch: Object.fromEntries(Object.entries(discovery.custom).map(([keyword, rows]) => [keyword, rows.length])) }, discoveryWarnings: discovery.errors,
  rules: { fullSort: "Trending daily 新增 Star 降序", chineseSort: "Trending 中文候选的 daily 新增 Star 降序", chineseRatioThreshold: CHINESE_RATIO, minChineseCharacters: MIN_HAN }
};
await saveJson(path.join(DATA, "latest.json"), report);
await saveJson(path.join(DATA, "snapshots", DATE + ".json"), snapshot);
await saveJson(snapshotIndexFile, [{ date: DATE, collectedAt: snapshot.collectedAt }, ...snapshotIndex.filter((item) => item.date !== DATE)]);
await saveJson(path.join(DOCS, "history", DATE + ".json"), report);
await mkdir(DOCS, { recursive: true });
await writeFile(path.join(DOCS, "index.html"), html(report), "utf8");
const historyFile = path.join(DATA, "history", "index.json");
const history = await readJson(historyFile, []);
await saveJson(historyFile, [{ date: DATE, collectedAt: report.collectedAt, path: "history/" + DATE + ".json" }, ...history.filter((item) => item.date !== DATE)]);
console.log("Generated " + DATE + ": " + boards.full.length + " global, " + boards.chinese.length + " Chinese, " + boards.aiGrowth.length + " AI and " + boards.newProjects.length + " new projects.");
