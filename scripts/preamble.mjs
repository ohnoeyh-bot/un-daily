// 결의문 PDF 텍스트에서 서문(Preamble)만 잘라 문단별로 나눈다.
// 원문 문장은 AI가 아니라 이 코드가 그대로 잘라내므로 글자가 바뀌지 않는다.

const NOISE = [
  /^[SA]\/RES\/[\d/]+(\s*\(\d{4}\))?$/,      // 쪽 머리 문서번호
  /^\d{2}-\d{5}.*$/,                          // 26-15702 (E) 같은 관리번호
  /^\*\d+\*$/,                                // 바코드 숫자
  /^\d{1,3}\/\d{1,3}$/,                        // 쪽 번호 2/5
  /^\d{1,3}$/,                                // 단독 쪽 번호
  /^Please recycle/i,
  /^_{3,}$/,                                  // 각주 구분선
];

// 문단 첫 단어로 자주 나오는 말 (-ing, -ed 로 끝나지 않는 것들)
const LEAD_WORDS = new Set(
  "mindful aware conscious cognizant deeply gravely strongly further also bearing guided convinced alarmed acknowledging noting underscoring welcoming taking having emphasizing determined desirous fully keenly profoundly seriously stressing reaffirming recalling recognizing affirming".split(" ")
);

function isLeadStart(line) {
  const w = (line.match(/^[A-Z][a-z-]+/) || [""])[0].toLowerCase();
  if (!w) return false;
  return /(ing|ed)$/.test(w) || LEAD_WORDS.has(w);
}

export function extractPreamble(rawText) {
  const lines = rawText
    .replace(/\f/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").replace(/^\s+/, ""))
    // 각주 번호(위첨자) 제거: "for 2025, 1" → "for 2025,"  /  "Rights,1 and" → "Rights, and"
    .map((l) => l.replace(/([,;:])\s?\d{1,2}$/, "$1").replace(/([A-Za-z”’)][,;:.])\d{1,2}(?=\s)/g, "$1"))
    .filter((l) => l && !NOISE.some((re) => re.test(l)));

  const start = lines.findIndex((l) => /^The (Security Council|General Assembly|Human Rights Council|Economic and Social Council),?$/.test(l));
  if (start < 0) return null;
  const opening = lines[start];
  const rest = lines.slice(start + 1);
  // 본문(주문, operative) 시작: "1. " 로 시작하는 줄
  let end = rest.findIndex((l) => /^1\.(\s|$)/.test(l));
  // 결정문 앞의 마지막 서문 문단 뒤에 오는 'Acting under Chapter VII ...' 같은 줄도 서문에 포함
  if (end < 0) end = rest.length;
  const body = rest.slice(0, end);
  // "1." 바로 앞의 소제목 줄(문장부호로 끝나지 않는 줄)은 서문이 아니므로 뺀다
  while (body.length && !/[,;:.]$/.test(body[body.length - 1])) body.pop();

  // 각주 줄 제거: 페이지 아래쪽 "1 Resolution 217 A (III)." 형태
  const cleaned = body.filter((l) => !/^\d{1,2}\s+(See|Resolution|Resolutions|A\/|S\/|E\/|United Nations|Official Records|Ibid|Treaty|General Assembly|Adopted|Available|www\.|https?:)/.test(l));

  const paras = [];
  let cur = [];
  for (let i = 0; i < cleaned.length; i++) {
    const l = cleaned[i];
    if (cur.length && /[,;:]$/.test(cur[cur.length - 1]) && isLeadStart(l)) {
      paras.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) paras.push(cur);

  const joined = paras.map((p) =>
    p.reduce((acc, l) => (acc.endsWith("-") && /^[a-z]/.test(l) ? acc.slice(0, -1) + l : acc ? acc + " " + l : l), "")
  );
  // 마지막 문단이 주문으로 넘어가는 줄("Acts ...", "Decides ...")이면 그대로 둠 — 서문 범위만 남았는지 확인
  if (!joined.length || !isLeadStart(joined[0])) return null; // 서문 없는 결의(선언문 채택 등)
  return { opening: opening.replace(/,?$/, ","), paragraphs: joined };
}
