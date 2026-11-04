// 매일 한 번 실행: 국제뉴스 3개 + 최신 UN 결의문 서문을 모아 data/ 에 저장한다.
// 실행: ANTHROPIC_API_KEY=... node scripts/update.mjs
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import { extractPreamble } from "./preamble.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = { "User-Agent": "Mozilla/5.0 (un-daily study app)" };
const MODEL = "claude-opus-5-5";

// 로그인 방식
// - GitHub Actions 안: 워크로드 ID(키 없이 GitHub 신분증으로 로그인). 호출할 때마다 GitHub에서 새 신분증을 받는다
// - 내 Mac: ANTHROPIC_API_KEY 환경변수
function makeClient() {
  const env = process.env;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    const githubToken = async () => {
      const res = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent("https://api.anthropic.com")}`, {
        headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      });
      if (!res.ok) throw new Error("GitHub 신분증(OIDC 토큰) 발급 실패: " + res.status);
      const jwt = (await res.json()).value;
      // 로그인 실패 원인 확인용: 신분증의 내용(서명 제외)만 기록
      const c = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
      console.log("GitHub 신분증:", JSON.stringify({ sub: c.sub, aud: c.aud, repository_owner: c.repository_owner, repository_owner_id: c.repository_owner_id, ref: c.ref, event_name: c.event_name }));
      return jwt;
    };
    return new Anthropic({
      credentials: oidcFederationProvider({
        identityTokenProvider: githubToken,
        federationRuleId: env.ANTHROPIC_FEDERATION_RULE_ID,
        organizationId: env.ANTHROPIC_ORGANIZATION_ID,
        serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID,
        workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined,
        baseURL: "https://api.anthropic.com",
        fetch,
      }),
    });
  }
  return new Anthropic();
}
const client = process.argv.includes("--check") ? null : makeClient();

// 한국 시간 기준 오늘 날짜
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ---------- 공통 ----------
async function get(url, asBuffer = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(40000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const decode = (s = "") =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// 구조화 출력: 정해진 JSON 모양으로만 답하게 한다
async function ask({ system, prompt, schema, maxTokens = 16000 }) {
  // 긴 답(결의문 번역)은 스트리밍으로 받아야 시간 제한에 안 걸린다
  const res = await client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: prompt }],
  }).finalMessage();
  if (res.stop_reason === "refusal") throw new Error("AI가 요청을 거절함: " + JSON.stringify(res.stop_details));
  if (res.stop_reason === "max_tokens") throw new Error("AI 답이 길이 제한에서 잘림");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

const obj = (props, required = Object.keys(props)) => ({
  type: "object", properties: props, required, additionalProperties: false,
});
const str = { type: "string" };
const VOCAB = { type: "array", items: obj({ en: str, ko: str }) };

// ---------- 1. 뉴스 ----------
const FEEDS = [
  { source: "UN News", url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml" },
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
];

async function collectItems() {
  const items = [];
  for (const f of FEEDS) {
    try {
      const xml = await get(f.url);
      for (const it of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
        const pick = (tag) => decode((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
        const pub = new Date(pick("pubDate"));
        if (isNaN(pub) || Date.now() - pub > 36 * 3600e3) continue; // 최근 36시간만
        items.push({ source: f.source, title: pick("title"), desc: pick("description").slice(0, 300), url: pick("link"), published: pub.toISOString() });
      }
    } catch (e) {
      console.warn("피드 실패:", f.source, e.message);
    }
  }
  return items.map((x, i) => ({ id: i, ...x }));
}

async function articleText(url) {
  try {
    const html = await get(url);
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1])).filter((t) => t.length > 60);
    return paras.join("\n").slice(0, 6000);
  } catch {
    return "";
  }
}

async function makeNews() {
  const items = await collectItems();
  if (items.length < 3) throw new Error(`최근 기사가 ${items.length}개뿐`);
  console.log("수집 기사:", items.length);

  const { picks } = await ask({
    system: "You are the editor of a daily international-affairs briefing for a Korean graduate-school applicant preparing for a career in international organizations.",
    prompt:
      "Below are recent headlines (JSON). Pick exactly 3 stories for today's briefing.\n" +
      "Rules:\n- international significance (diplomacy, conflict, UN, global economy, climate, human rights)\n- 3 different topics/regions, no duplicates of the same event\n- skip sport, celebrity, live blogs, opinion pieces\n\n" +
      JSON.stringify(items.map(({ id, source, title, desc }) => ({ id, source, title, desc }))),
    schema: obj({ picks: { type: "array", items: obj({ id: { type: "integer" }, why: str }) } }),
    maxTokens: 4000,
  });

  const chosen = picks.slice(0, 3).map((p) => items.find((x) => x.id === p.id)).filter(Boolean);
  if (chosen.length < 3) throw new Error("AI가 기사 3개를 고르지 못함");
  for (const c of chosen) c.body = await articleText(c.url);

  const { news } = await ask({
    system: "You write short, accurate English news briefs for an advanced learner of English (B2-C1). Use only facts stated in the given article text. Never add facts.",
    prompt:
      "For each article below write:\n" +
      "- id: same id\n- headline: plain English headline, max 12 words\n- headline_ko: natural Korean translation of headline\n" +
      "- summary_en: 2-3 sentences, max 60 words, clear and neutral\n" +
      "- summary_ko: natural Korean translation of summary_en\n" +
      "- vocab: 3-4 useful English words or phrases that appear in summary_en, with Korean meaning (ko)\n" +
      "- glossary: EVERY word or phrase in headline and summary_en that a Korean B2 learner might look up (usually 8-15). en = exactly as it appears in the text; ko = short Korean meaning in this context\n\n" +
      JSON.stringify(chosen.map(({ id, source, title, desc, body }) => ({ id, source, title, desc, body: body || desc }))),
    schema: obj({ news: { type: "array", items: obj({ id: { type: "integer" }, headline: str, headline_ko: str, summary_en: str, summary_ko: str, vocab: VOCAB, glossary: VOCAB }) } }),
  });

  return chosen.map((c) => {
    const n = news.find((x) => x.id === c.id);
    if (!n) throw new Error("요약 누락: " + c.title);
    return { source: c.source, url: c.url, published: c.published, original_title: c.title, headline: n.headline, headline_ko: n.headline_ko, summary_en: n.summary_en, summary_ko: n.summary_ko, vocab: n.vocab, glossary: n.glossary };
  });
}

// ---------- 2. 결의문 ----------
function marc(rec, tag, code) {
  const m = rec.match(new RegExp(`tag="${tag}"[^>]*>(?:(?!</datafield>)[\\s\\S])*?code="${code}">([^<]*)`));
  return m ? decode(m[1]) : "";
}

async function latestResolutions() {
  const out = [];
  for (const pattern of ["S/RES/*", "A/RES/*"]) {
    const url = `https://digitallibrary.un.org/search?ln=en&c=Resolutions%20and%20Decisions&p=${encodeURIComponent("191__a:" + pattern)}&rg=6&sf=latest+first&so=d&of=xm`;
    const xml = await get(url);
    for (const rec of xml.match(/<record>[\s\S]*?<\/record>/g) || []) {
      const pdf = (rec.match(/code="u">([^<]*-EN\.pdf)/) || [])[1];
      const symbol = marc(rec, "191", "a");
      if (!pdf || !symbol) continue;
      out.push({
        symbol,
        adopted: marc(rec, "269", "a"),
        title: marc(rec, "245", "a").replace(/\s*[/:]\s*$/, ""),
        subtitle: marc(rec, "245", "b").replace(/\s*[/:]\s*$/, ""),
        pdf_url: pdf,
        record_url: "https://digitallibrary.un.org/record/" + (rec.match(/tag="001">(\d+)/) || [])[1],
      });
    }
  }
  return out.sort((a, b) => b.adopted.localeCompare(a.adopted));
}

const fileOf = (symbol) => symbol.replace(/[^A-Za-z0-9]+/g, "_").replace(/_$/, "") + ".json";

async function makeResolution() {
  const list = await latestResolutions();
  for (const r of list) {
    const file = path.join(DATA, "resolutions", fileOf(r.symbol));
    if (fs.existsSync(file)) return r.symbol; // 이미 만든 최신 결의문 → 그대로 사용
    const tmp = path.join(ROOT, ".tmp.pdf");
    fs.writeFileSync(tmp, await get(r.pdf_url, true));
    const text = execFileSync("pdftotext", [tmp, "-"]).toString();
    fs.unlinkSync(tmp);
    const pre = extractPreamble(text);
    if (!pre) {
      console.log("서문 없음, 건너뜀:", r.symbol);
      continue;
    }

    const res = await ask({
      system: "You are a translator specialising in UN documents (English → Korean). Use standard Korean UN terminology (e.g. 'Reaffirming' → '재확인하며', 'Deeply concerned' → '깊이 우려하며').",
      prompt:
        `Resolution ${r.symbol}: ${r.title}${r.subtitle ? " — " + r.subtitle : ""}\n` +
        "Below are its preambular paragraphs, numbered. For EACH paragraph return:\n" +
        "- n: same number\n- lead: the opening participle/phrase exactly as it starts the paragraph (e.g. 'Reaffirming', 'Expressing deep concern', 'Recognizing also')\n" +
        "- ko: faithful Korean translation of the whole paragraph\n\n" +
        "Also return:\n- topic_en: what this resolution is about, short English line (e.g. 'Children and armed conflict: digital technologies')\n- topic_ko: the same in Korean\n" +
        "- vocab: 6-10 typical UN expressions used in these paragraphs (en exactly as written, ko meaning)\n" +
        "- glossary: EVERY word or phrase in the paragraphs that a Korean B2 learner might look up (en exactly as written, ko = short meaning in this context)\n\n" +
        pre.paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n"),
      schema: obj({
        topic_en: str,
        topic_ko: str,
        paragraphs: { type: "array", items: obj({ n: { type: "integer" }, lead: str, ko: str }) },
        vocab: VOCAB,
        glossary: VOCAB,
      }),
      maxTokens: 32000,
    });

    const paragraphs = pre.paragraphs.map((en, i) => {
      const t = res.paragraphs.find((p) => p.n === i + 1);
      if (!t) throw new Error(`번역 누락: ${r.symbol} 문단 ${i + 1}`);
      // 강조할 첫 구절은 원문 앞부분과 정확히 일치할 때만 사용
      const lead = en.startsWith(t.lead) ? t.lead : en.split(" ")[0];
      return { lead, en, ko: t.ko };
    });

    const body = /^S\//.test(r.symbol) ? "Security Council" : "General Assembly";
    fs.writeFileSync(
      file,
      JSON.stringify({ ...r, body, opening: pre.opening, topic_en: res.topic_en, topic_ko: res.topic_ko, paragraphs, vocab: res.vocab, glossary: res.glossary }, null, 2)
    );
    console.log("새 결의문:", r.symbol, paragraphs.length + "문단");
    return r.symbol;
  }
  throw new Error("서문 있는 최신 결의문을 찾지 못함");
}

// ---------- 실행 ----------
if (process.argv.includes("--check")) {
  // AI 없이 수집 부분만 점검
  const items = await collectItems();
  console.log("기사", items.length, "개 · 출처별", Object.entries(items.reduce((a, x) => ((a[x.source] = (a[x.source] || 0) + 1), a), {})));
  console.log("본문 길이 예시:", (await articleText(items[0].url)).length, items[0].url);
  for (const r of (await latestResolutions()).slice(0, 6)) {
    const t = execFileSync("pdftotext", ["-", "-"], { input: await get(r.pdf_url, true) }).toString();
    const pre = extractPreamble(t);
    console.log(r.adopted, r.symbol, pre ? pre.paragraphs.length + "문단" : "서문 없음", "|", r.title, r.subtitle);
  }
  process.exit(0);
}
const dayFile = path.join(DATA, "days", today + ".json");
const errors = [];
let news = [], resolution = null;
try { news = await makeNews(); } catch (e) { errors.push("news: " + e.message); }
try { resolution = await makeResolution(); } catch (e) { errors.push("resolution: " + e.message); }
errors.forEach((e) => console.error("⚠️", e));
if (!news.length && !resolution) process.exit(1);

// 실패한 쪽은 기존 파일 내용 유지
const prev = fs.existsSync(dayFile) ? JSON.parse(fs.readFileSync(dayFile, "utf8")) : {};
const day = { date: today, news: news.length ? news : prev.news || [], resolution: resolution || prev.resolution || null };
fs.writeFileSync(dayFile, JSON.stringify(day, null, 2));

// 목차(index.json): 날짜 최신순
const days = fs.readdirSync(path.join(DATA, "days")).filter((f) => f.endsWith(".json")).sort().reverse();
const index = days.map((f) => {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, "days", f), "utf8"));
  return { date: d.date, headlines: d.news.map((n) => n.headline), resolution: d.resolution };
});
fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify(index, null, 2));
console.log("완료:", today, errors.length ? "(일부 실패)" : "");
if (errors.length) process.exitCode = 1;
