// explain.*.md 를 그리는 아주 작은 마크다운 렌더러. 정책 설명 문서가 쓰는 문법만 다룬다:
// #, ## 제목 / - 목록 / --- 구분선 / **굵게** / `코드` / 빈 줄로 나뉜 문단.
import type { ReactNode } from 'react';

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const token = match[0];
    if (token.startsWith('**')) out.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyPrefix}-c${i}`}>{token.slice(1, -1)}</code>);
    last = start + token.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ');
    blocks.push(<p key={`p${key++}`}>{inline(text, `p${key}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul${key++}`}>
        {list.map((item, i) => (
          <li key={i}>{inline(item, `li${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push(<h3 key={`h${key++}`}>{inline(line.slice(3), `h${key}`)}</h3>);
      continue;
    }
    if (line.startsWith('# ')) {
      flushParagraph();
      flushList();
      blocks.push(<h2 key={`h${key++}`}>{inline(line.slice(2), `h${key}`)}</h2>);
      continue;
    }
    if (line.trim() === '---') {
      flushParagraph();
      flushList();
      blocks.push(<hr key={`hr${key++}`} />);
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^\s*-\s+/, ''));
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return <div className="md">{blocks}</div>;
}

/**
 * 정책 설명 문서에서 사람이 읽을 본문과 기술 정보를 나눈다.
 * - 제목의 "(실행 run_id)" / "（実行run_id）" 를 뗀다
 * - 문장 끝의 규칙 ID "(R1b)" / "（R5）" 를 뗀다
 * - 마지막 --- 아래(결정 지문·이미지·커밋 줄)는 기술 정보로 보낸다
 */
export function prepareExplain(source: string): { body: string; technical: string } {
  let text = source.replace(/\r\n/g, '\n');
  text = text.replace(/^(# .*?)\s*[(（]\s*(실행|実行)\s*[^)）]*[)）]/m, '$1');
  text = text.replace(/\s*[(（](R\d+[a-z]?|RB\d+|default)[)）]/g, '');
  const idx = text.lastIndexOf('\n---');
  if (idx === -1) return { body: text.trim(), technical: '' };
  return { body: text.slice(0, idx).trim(), technical: text.slice(idx + 4).trim() };
}
