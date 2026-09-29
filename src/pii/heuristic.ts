/**
 * 2층: 규칙 기반 판정기 (결정적, AI 없음)
 *
 * 신호 두 종류:
 *   - 이름 신호  : 칼럼 이름에 개인정보 단어가 들어 있다 (phone, email, 연락처 ...)
 *   - 쓰임새 신호: 그 칼럼이 코드에서 개인정보처럼 쓰인다 (input type="tel", 전화번호 정규식, SMS 발송 ...)
 *
 * 판정:
 *   이름 신호 + 쓰임새 신호 1개 이상, 또는 쓰임새 신호 2종 이상 → confident = true
 *   신호가 하나뿐                                             → confident = false (애매 → 사람 승인)
 *   신호 없음                                                 → 결과에서 제외
 */
import type { Classification, Classifier } from "./classifier.js";
import type { ColumnCandidate, Snippet } from "./extractor.js";
import { wordPattern } from "./extractor.js";

export type PiiKind = "phone" | "email" | "address" | "birthdate" | "national_id";

// ---------------------------------------------------------------------------
// 이름 신호
// ---------------------------------------------------------------------------

const NAME_DICTIONARY: Record<PiiKind, string[]> = {
  phone: ["phone", "tel", "telephone", "mobile", "cell", "cellphone", "fax", "contact", "연락처", "전화", "전화번호", "휴대폰", "핸드폰"],
  email: ["email", "mail", "이메일", "메일"],
  address: ["address", "addr", "street", "zip", "zipcode", "postal", "postcode", "주소", "우편번호"],
  birthdate: ["birth", "birthday", "birthdate", "dob", "born", "생년월일", "생년", "생일"],
  national_id: ["ssn", "rrn", "jumin", "resident", "passport", "주민번호", "주민등록번호", "여권"],
};

/** 이 토큰이 있으면 이름 신호를 무시한다: 개수·플래그·외래키 등은 개인정보 값이 아니다 */
const NEGATIVE_TOKENS = new Set(["id", "ids", "count", "cnt", "total", "sum", "avg", "flag", "enabled", "active", "at", "ts", "len", "length", "size"]);

/** 숫자·불리언 타입 칼럼은 이름이 개인정보 같아도 값이 개인정보일 가능성이 낮다 */
const NON_TEXT_TYPE = /^(?:int|integer|bigint|smallint|tinyint|serial|bigserial|bool|boolean|float|double|decimal|numeric|real|number)/i;

export function tokenize(name: string): string[] {
  return name
    .split(/[_\-\s.]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function nameSignal(column: string, type: string): PiiKind | null {
  const tokens = tokenize(column);
  if (tokens.some((t) => NEGATIVE_TOKENS.has(t))) return null;
  if (NON_TEXT_TYPE.test(type)) return null;
  const lower = column.toLowerCase();
  for (const [kind, words] of Object.entries(NAME_DICTIONARY) as [PiiKind, string[]][]) {
    for (const word of words) {
      const isKorean = /[ㄱ-힝]/.test(word);
      if (isKorean ? lower.includes(word) : tokens.includes(word)) return kind;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 쓰임새 신호
// ---------------------------------------------------------------------------

interface UsageSignal {
  id: string;
  kind: PiiKind;
  /** snippet 이 이 칼럼에 대한 신호인지 */
  test: (snippet: Snippet, column: string) => boolean;
}

/**
 * 이 줄의 <input ...> 태그 중 name/id 가 이 칼럼이고 type 이 주어진 값인 것이 있는가.
 * 태그가 여러 줄에 걸쳐 있으면(줄에 '<input' 은 있는데 '>' 로 안 닫힘) 앞뒤 줄까지 본다.
 */
function inputTagWithType(snippet: Snippet, column: string, types: string[]): boolean {
  const opensTag = /<(?:input|textarea|select)\b/i.test(snippet.text);
  if (!opensTag) return false;
  const source = /<(?:input|textarea|select)\b[^>]*>/i.test(snippet.text) ? snippet.text : snippet.context;
  const tags = source.match(/<(?:input|textarea|select)\b[^>]*>/gis) ?? [];
  return tags.some((tag) => {
    const nameAttr = /\b(?:name|id)\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    let refersToColumn = false;
    while ((m = nameAttr.exec(tag)) !== null) if (m[1] === column) refersToColumn = true;
    if (!refersToColumn) return false;
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    return type !== undefined && types.includes(type);
  });
}

/** 같은 줄에 정규식 리터럴이 있고 그 줄에 칼럼이 등장하는가 */
function regexOnLine(snippet: Snippet, column: string, pattern: RegExp): boolean {
  return wordPattern(column).test(snippet.text) && pattern.test(snippet.text);
}

/** `호출(칼럼, ...)` 처럼 칼럼이 호출의 첫 번째 인자에 있는가 */
function callWithColumnAsFirstArg(snippet: Snippet, column: string, callPattern: string): boolean {
  const re = new RegExp(`(?:${callPattern})\\s*\\(\\s*[^,()]*?(?<![\\p{L}\\p{N}_$])${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_$])`, "iu");
  return re.test(snippet.text);
}

const USAGE_SIGNALS: UsageSignal[] = [
  { id: "input_tel", kind: "phone", test: (s, c) => inputTagWithType(s, c, ["tel"]) },
  { id: "input_email", kind: "email", test: (s, c) => inputTagWithType(s, c, ["email"]) },
  {
    id: "phone_regex",
    kind: "phone",
    test: (s, c) => regexOnLine(s, c, /\\d\{(?:2|3|4)(?:,\d)?\}[^/]*\\d\{4\}|\\d\{(?:9|10|11)(?:,\d+)?\}|\+?82/),
  },
  { id: "email_regex", kind: "email", test: (s, c) => regexOnLine(s, c, /\/[^/\n]*@[^/\n]*\\\.[^/\n]*\//) },
  { id: "sms_call", kind: "phone", test: (s, c) => callWithColumnAsFirstArg(s, c, "send_?sms|sendSMS|sendText|twilio\\.messages\\.create|알림톡|문자발송|sendAlimtalk") },
  { id: "email_call", kind: "email", test: (s, c) => callWithColumnAsFirstArg(s, c, "send_?mail|send_?email|mailer\\.send|transporter\\.sendMail") },
  { id: "address_api", kind: "address", test: (s, c) => regexOnLine(s, c, /\b(?:geocode\w*|postcode|daum\.Postcode|kakao\.maps)\b|주소\s*검색/i) },
];

// ---------------------------------------------------------------------------
// HeuristicClassifier
// ---------------------------------------------------------------------------

export interface HeuristicDetail {
  nameKind: PiiKind | null;
  usageSignals: Array<{ id: string; kind: PiiKind; at: string }>;
}

export function analyze(candidate: ColumnCandidate): HeuristicDetail {
  const nameKind = nameSignal(candidate.column, candidate.type);
  const seen = new Set<string>();
  const usageSignals: HeuristicDetail["usageSignals"] = [];
  for (const snippet of candidate.usages) {
    for (const signal of USAGE_SIGNALS) {
      if (seen.has(signal.id)) continue;
      if (signal.test(snippet, candidate.column)) {
        seen.add(signal.id);
        usageSignals.push({ id: signal.id, kind: signal.kind, at: `${snippet.file}:${snippet.line}` });
      }
    }
  }
  return { nameKind, usageSignals };
}

export class HeuristicClassifier implements Classifier {
  readonly name = "heuristic";

  classifyOne(candidate: ColumnCandidate): Classification | null {
    const { nameKind, usageSignals } = analyze(candidate);
    const signalCount = (nameKind ? 1 : 0) + usageSignals.length;
    if (signalCount === 0) return null;

    const confident = (nameKind !== null && usageSignals.length >= 1) || usageSignals.length >= 2;
    const kind = nameKind ?? usageSignals[0]!.kind;
    const locations = usageSignals.length
      ? [...new Set(usageSignals.map((s) => s.at))].slice(0, 3)
      : [`${candidate.definition.file}:${candidate.definition.line}`];

    return {
      table: candidate.table,
      column: candidate.column,
      kind,
      evidence: locations.join(", "),
      confident,
      source: "heuristic",
    };
  }

  async classify(candidates: ColumnCandidate[]): Promise<Classification[]> {
    const out: Classification[] = [];
    for (const c of candidates) {
      const r = this.classifyOne(c);
      if (r) out.push(r);
    }
    return out;
  }
}
