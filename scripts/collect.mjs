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
  const payload = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub 每日情报 · ${report.date}</title><style>
:root{color-scheme:dark;--bg:#090d14;--panel:#111827;--panel2:#161f2e;--line:#263247;--text:#e8edf6;--muted:#9ba9be;--blue:#68a8ff;--hot:#ff8375;--green:#64d8a2;--tag:#1c3155}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#17284a 0,transparent 34%),var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{max-width:1120px;margin:auto;padding:34px 20px 70px}header{padding-bottom:22px;border-bottom:1px solid var(--line)}h1{margin:0 0 8px;font-size:32px;letter-spacing:.2px}.meta,.subtitle{margin:0;color:var(--muted);line-height:1.6}.tabs{display:flex;gap:8px;overflow:auto;padding:22px 0 6px;position:sticky;top:0;background:linear-gradient(var(--bg) 78%,transparent);z-index:3}.tab,.subtab{border:1px solid var(--line);background:#101827;color:#c8d3e3;border-radius:999px;padding:9px 13px;white-space:nowrap;cursor:pointer;font:inherit;font-size:14px}.tab:hover,.subtab:hover{border-color:#4b78b9}.tab.active,.subtab.active{background:var(--blue);border-color:var(--blue);color:#061225;font-weight:750}.board{padding-top:14px}.board h2{margin:12px 0 5px;font-size:24px}.subtabs{display:flex;gap:8px;overflow:auto;margin:16px 0}.card{display:flex;gap:16px;margin-top:13px;padding:18px;background:linear-gradient(135deg,#141d2b,#101722);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 30px #0002}.rank{min-width:38px;color:var(--blue);font-size:20px}.card a{font-size:17px;font-weight:750;color:#82b7ff;text-decoration:none;word-break:break-all}.card a:hover{text-decoration:underline}.card p{margin:8px 0 12px;color:#c7d0df;line-height:1.55}.metrics{display:flex;flex-wrap:wrap;gap:9px 18px;font-size:13px}.metrics span{color:var(--muted)}.metrics strong{color:var(--text)}.metrics .hot{color:var(--hot)}.badge{display:inline-block;margin:12px 7px 0 0;padding:3px 8px;border-radius:999px;background:var(--tag);color:#a6c6ff;font-size:12px}.estimate{background:#3f3220;color:#ffd58a}.empty,.warning{margin-top:14px;padding:15px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--muted)}.warning{border-color:#765b28;color:#ffd58a}footer{margin-top:42px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}footer a{color:var(--blue)}@media(max-width:560px){main{padding:22px 13px}.card{padding:14px;gap:10px}h1{font-size:27px}.tabs{margin:0 -13px;padding-left:13px}}
</style></head><body><main><header><h1>GitHub 每日情报</h1><p class="meta">${report.date} · 采集于 ${report.collectedAtShanghai}（北京时间）</p><p class="meta">排名由真实 GitHub 数据计算；AI 不参与榜单排序。</p></header><nav id="tabs" class="tabs" aria-label="榜单选择"></nav><section id="board" class="board"></section><footer>数据范围：公开 GitHub 数据 · 密钥只保存在后台 GitHub Actions Secret，不会显示在网页中。历史日报：<a href="./history/${report.date}.json">${report.date}</a></footer></main><script id="report-data" type="application/json">${payload}</script><script>
(() => {
  const report=JSON.parse(document.getElementById("report-data").textContent);
  const tabs=[
    ["full","今日全站热门 Top 10","GitHub Trending daily，按页面显示的今日新增 Star 排序。"],
    ["chinese","今日中文热门 Top 10","GitHub Trending 中文候选，经简介与 README 中文内容校验。"],
    ["starGrowth","24h Star 增长 Top 10","当前 Star 减前一个不同日期快照。"],
    ["forkGrowth","24h Fork 增长 Top 10","当前 Fork 减前一个不同日期快照。"],
    ["aiGrowth","AI 项目增长 Top 10","每天重新搜索 AI 候选池；按真实 24h Star 增量。"],
    ["newProjects","新项目爆发榜","近 5 天创建；无前日快照时显示带“估算”标识的 Star/日。"],
    ["custom","关键词增长榜","按你设置的关键词每天重新搜索；按真实 24h Star 增量。"]
  ];
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const tabsEl=document.getElementById("tabs"), board=document.getElementById("board");
  let active="full", keyword=Object.keys(report.boards.customKeywords||{})[0]||"";
  function card(r){
    const growth=v=>v==null?"基线中":(v>=0?"+":"")+Number(v).toLocaleString();
    const hot=r.todayStars==null?"未提供":"+"+Number(r.todayStars).toLocaleString();
    const age=r.createdAt?new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium"}).format(new Date(r.createdAt)):"未提供";
    const estimate=r.estimatedVelocity==null?"":'<span>Star/日 <strong>'+esc(r.estimatedVelocity)+'</strong></span><i class="badge estimate">估算</i>';
    const badges='<i class="badge">'+(r.chineseProject?"中文项目":"公开项目")+'</i>'+(r.aiCategory?'<i class="badge">'+esc(r.aiCategory)+'</i>':"");
    return '<article class="card"><b class="rank">#'+esc(r.rank)+'</b><div><a href="'+esc(r.url)+'" target="_blank" rel="noreferrer">'+esc(r.fullName)+'</a><p>'+esc(r.description||"暂无仓库简介")+'</p><div class="metrics"><span>Star <strong>'+Number(r.stars||0).toLocaleString()+'</strong></span><span>Fork <strong>'+Number(r.forks||0).toLocaleString()+'</strong></span><span>24h Star <strong class="hot">'+growth(r.starGrowth24h)+'</strong></span><span>24h Fork <strong>'+growth(r.forkGrowth24h)+'</strong></span><span>今日热度 <strong class="hot">'+hot+'</strong></span>'+estimate+'<span>'+esc(r.language||"未标注")+'</span><span>创建于 '+age+'</span></div>'+badges+'</div></article>';
  }
  function rowsFor(key){return key==="custom"?(report.boards.customKeywords?.[keyword]||[]):(report.boards[key]||[])}
  function render(){
    tabsEl.innerHTML=tabs.map(([key,label])=>'<button class="tab '+(key===active?"active":"")+'" data-key="'+key+'">'+label+'</button>').join("");
    tabsEl.querySelectorAll("button").forEach(b=>b.onclick=()=>{active=b.dataset.key;render()});
    const meta=tabs.find(t=>t[0]===active), rows=rowsFor(active);
    const baseline=["starGrowth","forkGrowth","aiGrowth","custom"].includes(active)&&report.baselineBuilding;
    let extra="";
    if(active==="custom"){const keys=Object.keys(report.boards.customKeywords||{});extra='<div class="subtabs">'+keys.map(k=>'<button class="subtab '+(k===keyword?"active":"")+'" data-keyword="'+esc(k)+'">'+esc(k)+'</button>').join("")+'</div>'}
    board.innerHTML='<h2>'+meta[1]+'</h2><p class="subtitle">'+meta[2]+'</p>'+extra+(baseline?'<p class="empty">正在建立首日基线；下一采集日期出现后显示真实 24h 增长。</p>':(rows.length?rows.map(card).join(""):'<p class="empty">本次没有满足规则的项目。</p>'));
    board.querySelectorAll("[data-keyword]").forEach(b=>b.onclick=()=>{keyword=b.dataset.keyword;render()});
  }
  render();
})();
</script></body></html>`;
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
