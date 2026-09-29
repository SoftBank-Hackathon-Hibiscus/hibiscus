/**
 * 파괴적 DB 마이그레이션 판정 (결정적, AI 없음)
 *
 * SQL 마이그레이션 파일에서 이전 버전과 호환되지 않는 변경을 찾는다.
 *   DROP TABLE, DROP COLUMN, RENAME TABLE/COLUMN, ALTER COLUMN ... TYPE,
 *   기존 테이블에 DEFAULT 없는 NOT NULL 칼럼 추가, 기존 칼럼에 NOT NULL 걸기(SET NOT NULL), TRUNCATE
 * 주석(--, /* *​/)과 문자열('...') 안의 키워드는 무시한다. 그래서 문자열 안의 동적 SQL(EXECUTE '...') 은 보지 못한다.
 *
 * SET NOT NULL 은 데이터를 지우지 않지만, 이전 버전 앱이 NULL 을 쓰면 실패하므로 롤백이 깨진다 → 파괴적.
 * DROP NOT NULL 은 제약을 풀 뿐이라 안전하다.
 *
 * 이 파일은 파일을 읽지 않는다 (loader.ts 가 읽는다).
 */
import type { MigrationFinding, MigrationKind, MigrationReport } from "../schema.js";

export interface MigrationFile {
  /** 마이그레이션 이름 (--since 비교에 쓴다). migrations/0002_x.sql → "0002_x", prisma 는 폴더 이름 */
  name: string;
  /** 앱 폴더 기준 상대 경로 ('/' 구분) */
  path: string;
  content: string;
}

export interface Statement {
  /** 공백을 하나로 줄인 문장 */
  text: string;
  /** 1부터. 문장의 첫 글자가 있는 줄 */
  line: number;
}

const MAX_STATEMENT_CHARS = 120;

// ---------------------------------------------------------------------------
// 1) 주석과 문자열 제거 (줄 번호를 지키기 위해 줄바꿈은 남기고 나머지는 공백으로)
// ---------------------------------------------------------------------------

const blank = (s: string) => s.replace(/[^\n]/g, " ");

export function stripNoise(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, blank); // /* ... */
  out = out.replace(/'(?:[^'\n]|'')*'/g, (m) => `'${blank(m.slice(1, -1))}'`); // '...' ('' 는 이스케이프)
  out = out.replace(/--[^\n]*/g, blank); // -- ...
  return out;
}

// ---------------------------------------------------------------------------
// 2) 문장 분리
// ---------------------------------------------------------------------------

export function splitStatements(clean: string): Statement[] {
  const statements: Statement[] = [];
  let start = 0;
  const flush = (end: number) => {
    const raw = clean.slice(start, end);
    const firstNonSpace = raw.search(/\S/);
    if (firstNonSpace >= 0) {
      let line = 1;
      for (let i = 0; i < start + firstNonSpace; i++) if (clean.charCodeAt(i) === 10) line++;
      statements.push({ text: raw.replace(/\s+/g, " ").trim(), line });
    }
    start = end + 1;
  };
  for (let i = 0; i < clean.length; i++) if (clean[i] === ";") flush(i);
  flush(clean.length);
  return statements;
}

// ---------------------------------------------------------------------------
// 3) 파괴적 변경 탐지
// ---------------------------------------------------------------------------

const IDENT = "[`\"\\w.]+";
const NOT_A_COLUMN = /^(?:constraint|index|primary|foreign|unique|key|check|fulltext|spatial|partition)$/i;

/** ADD 절 하나를 괄호 깊이를 보며 다음 최상위 콤마 전까지 잘라낸다 */
function takeClause(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

export function detectKinds(statementText: string): MigrationKind[] {
  const t = statementText;
  const kinds: MigrationKind[] = [];
  const isAlterTable = /^ALTER TABLE\b/i.test(t);

  if (/^DROP TABLE\b/i.test(t)) kinds.push("drop_table");
  if (/^TRUNCATE\b/i.test(t)) kinds.push("truncate");
  if (/^RENAME TABLE\b/i.test(t) || (isAlterTable && /\bRENAME TO\b/i.test(t))) kinds.push("rename_table");

  if (isAlterTable) {
    if (new RegExp(`\\bRENAME (?:COLUMN )?(?!TO\\b)${IDENT} TO\\b`, "i").test(t)) kinds.push("rename_column");

    // PostgreSQL: ALTER [COLUMN] x [SET DATA] TYPE ...
    if (new RegExp(`\\bALTER (?:COLUMN )?${IDENT} (?:SET DATA )?TYPE\\b`, "i").test(t)) kinds.push("alter_column_type");
    // PostgreSQL: ALTER [COLUMN] x SET NOT NULL  (DROP NOT NULL 은 안전하므로 잡지 않는다)
    if (new RegExp(`\\bALTER (?:COLUMN )?${IDENT} SET NOT NULL\\b`, "i").test(t)) kinds.push("set_not_null");

    // MySQL: MODIFY / CHANGE 는 칼럼 정의를 통째로 다시 쓴다.
    // 절에 NOT NULL 이 있으면 "NOT NULL 걸기" 로, 없으면 "타입 변경" 으로 한 번만 잡는다 (겹치지 않게).
    const modifyRe = new RegExp(`\\b(?:MODIFY|CHANGE) (?:COLUMN )?${IDENT}`, "gi");
    let modify: RegExpExecArray | null;
    let modifySetsNotNull = false;
    let modifyChangesType = false;
    while ((modify = modifyRe.exec(t)) !== null) {
      const clause = takeClause(t, modify.index + modify[0].length);
      if (/\bNOT NULL\b/i.test(clause)) modifySetsNotNull = true;
      else modifyChangesType = true;
    }
    if (modifyChangesType && !kinds.includes("alter_column_type")) kinds.push("alter_column_type");
    if (modifySetsNotNull && !kinds.includes("set_not_null")) kinds.push("set_not_null");
    if (new RegExp(`\\bDROP (?:COLUMN )?(?:IF EXISTS )?(?!CONSTRAINT\\b|INDEX\\b|DEFAULT\\b|NOT\\b|PRIMARY\\b|FOREIGN\\b|KEY\\b|CHECK\\b|PARTITION\\b)${IDENT}`, "i").test(t)) {
      kinds.push("drop_column");
    }

    const addRe = new RegExp(`\\bADD (?:COLUMN )?(?:IF NOT EXISTS )?(${IDENT})`, "gi");
    let m: RegExpExecArray | null;
    let found = false;
    while (!found && (m = addRe.exec(t)) !== null) {
      const name = m[1]!.replace(/[`"]/g, "");
      if (NOT_A_COLUMN.test(name)) continue;
      const clause = takeClause(t, m.index + m[0].length);
      const notNull = /\bNOT NULL\b/i.test(clause);
      const hasDefault = /\bDEFAULT\b/i.test(clause);
      const autoValue = /\b(?:GENERATED|IDENTITY|SERIAL|AUTOINCREMENT|AUTO_INCREMENT)\b/i.test(clause);
      if (notNull && !hasDefault && !autoValue) found = true;
    }
    if (found) kinds.push("add_not_null_without_default");
  }

  return kinds;
}

function oneLine(text: string): string {
  return text.length > MAX_STATEMENT_CHARS ? `${text.slice(0, MAX_STATEMENT_CHARS - 1)}…` : text;
}

export function analyzeFile(file: MigrationFile): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  for (const st of splitStatements(stripNoise(file.content))) {
    for (const kind of detectKinds(st.text)) {
      findings.push({ kind, statement: oneLine(st.text), evidence: `${file.path}:${st.line}` });
    }
  }
  return findings;
}

/** 파일 순서는 이름 순으로 고정한다 (같은 입력이면 같은 결과) */
export function analyzeMigrations(files: MigrationFile[]): MigrationReport {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const findings = sorted.flatMap(analyzeFile);
  return { destructive: findings.length > 0, backward_compatible: findings.length === 0, findings };
}
