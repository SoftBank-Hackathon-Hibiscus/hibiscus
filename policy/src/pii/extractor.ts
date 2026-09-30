/**
 * 1층: 추출기 (결정적, AI 없음)
 *
 * 앱 소스에서 "칼럼 정의" 를 찾고, 칼럼마다 근거 조각(정의 위치 + 칼럼 이름이 등장하는 줄)을 모은다.
 * 여기서는 개인정보인지 판단하지 않는다. 판단은 classifier 가 한다.
 *
 * 지원: SQL CREATE TABLE, Prisma model. 나머지 파일(.js/.ts/.html)은 근거 조각 수집에만 쓴다.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { redact } from "./redact.js";

export interface SourceFile {
  /** 앱 폴더 기준 상대 경로. 구분자는 항상 '/' */
  path: string;
  content: string;
}

export interface Snippet {
  file: string;
  /** 1부터 시작 */
  line: number;
  /** 해당 줄 (비밀값 가림) */
  text: string;
  /** 앞뒤 1줄을 포함한 텍스트 (비밀값 가림) */
  context: string;
}

export interface ColumnCandidate {
  table: string;
  column: string;
  /** 선언된 타입. 모르면 빈 문자열 */
  type: string;
  definition: Snippet;
  usages: Snippet[];
}

export const SOURCE_EXTENSIONS = [".sql", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".html", ".prisma"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const MAX_USAGES_PER_COLUMN = 40;

// ---------------------------------------------------------------------------
// 파일 읽기 (유일하게 fs 를 쓰는 부분)
// ---------------------------------------------------------------------------

/**
 * symlink(정션 포함)는 따라가지 않고 건너뛴다: 앱 폴더 밖으로 나가거나 순환할 수 있다.
 * 건너뛴 경로는 onSkip 으로 알린다 (CLI 는 경고로 출력).
 */
export function loadSources(dir: string, onSkip?: (path: string) => void): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        onSkip?.(posixRelative(dir, full));
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      files.push({ path: posixRelative(dir, full), content: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return sortFiles(files);
}

function posixRelative(dir: string, full: string): string {
  return relative(dir, full).split("\\").join("/");
}

function sortFiles(files: SourceFile[]): SourceFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 조각 만들기
// ---------------------------------------------------------------------------

function makeSnippet(file: SourceFile, lines: string[], index: number): Snippet {
  const from = Math.max(0, index - 1);
  const to = Math.min(lines.length - 1, index + 1);
  return {
    file: file.path,
    line: index + 1,
    text: redact(lines[index]!.trim()),
    context: lines
      .slice(from, to + 1)
      .map((l) => redact(l))
      .join("\n"),
  };
}

function lineOfOffset(content: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** 여는 괄호 위치에서 짝이 맞는 닫는 괄호 위치를 찾는다. 없으면 -1 */
function findClosing(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 칼럼 정의 찾기
// ---------------------------------------------------------------------------

interface Definition {
  table: string;
  column: string;
  type: string;
  lineIndex: number;
}

const SQL_CONSTRAINT_PREFIX = /^(?:primary|foreign|unique|constraint|check|index|key|fulltext|spatial)\b/i;

function findSqlDefinitions(file: SourceFile): Definition[] {
  const defs: Definition[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?(\w+)[`"']?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.content)) !== null) {
    const table = m[1]!;
    const open = m.index + m[0].length - 1;
    const close = findClosing(file.content, open, "(", ")");
    if (close < 0) continue;
    const body = file.content.slice(open + 1, close);
    let offset = open + 1;
    for (const rawLine of body.split("\n")) {
      const lineIndex = lineOfOffset(file.content, offset);
      offset += rawLine.length + 1;
      const line = rawLine.replace(/--.*$/, "").trim().replace(/,$/, "").trim();
      if (!line || SQL_CONSTRAINT_PREFIX.test(line)) continue;
      const tokens = line.split(/\s+/);
      const column = tokens[0]!.replace(/^[`"']|[`"']$/g, "");
      if (!column || /^[()]/.test(column)) continue;
      defs.push({ table, column, type: (tokens[1] ?? "").replace(/[(),]/g, ""), lineIndex });
    }
  }
  return defs;
}

function findPrismaDefinitions(file: SourceFile): Definition[] {
  const defs: Definition[] = [];
  const re = /\bmodel\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.content)) !== null) {
    const table = m[1]!;
    const open = m.index + m[0].length - 1;
    const close = findClosing(file.content, open, "{", "}");
    if (close < 0) continue;
    const body = file.content.slice(open + 1, close);
    let offset = open + 1;
    for (const rawLine of body.split("\n")) {
      const lineIndex = lineOfOffset(file.content, offset);
      offset += rawLine.length + 1;
      const line = rawLine.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;
      const tokens = line.split(/\s+/);
      const column = tokens[0]!;
      const type = (tokens[1] ?? "").replace(/[?!]/g, "");
      // 관계 필드(다른 model 참조, 배열) 는 칼럼이 아니다
      if (type.endsWith("[]") || line.includes("@relation")) continue;
      defs.push({ table, column, type, lineIndex });
    }
  }
  return defs;
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 칼럼 이름이 단어로 등장하는지 (앞뒤가 글자/숫자/_/$ 가 아니어야 함. 한글 포함) */
export function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$])`, "u");
}

export function extract(inputFiles: SourceFile[]): ColumnCandidate[] {
  const files = sortFiles(inputFiles);
  const splitLines = new Map<string, string[]>();
  for (const f of files) splitLines.set(f.path, f.content.split("\n"));

  const candidates: ColumnCandidate[] = [];
  for (const file of files) {
    const defs = file.path.endsWith(".sql")
      ? findSqlDefinitions(file)
      : file.path.endsWith(".prisma")
        ? findPrismaDefinitions(file)
        : [];
    for (const def of defs) {
      const pattern = wordPattern(def.column);
      const usages: Snippet[] = [];
      for (const other of files) {
        const lines = splitLines.get(other.path)!;
        for (let i = 0; i < lines.length && usages.length < MAX_USAGES_PER_COLUMN; i++) {
          if (other.path === file.path && i === def.lineIndex) continue;
          if (pattern.test(lines[i]!)) usages.push(makeSnippet(other, lines, i));
        }
      }
      candidates.push({
        table: def.table,
        column: def.column,
        type: def.type,
        definition: makeSnippet(file, splitLines.get(file.path)!, def.lineIndex),
        usages,
      });
    }
  }
  return candidates;
}
