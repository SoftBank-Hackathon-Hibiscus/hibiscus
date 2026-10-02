// 토큰·모드 보관. localStorage 가 막힌 환경(사파리 비공개 등)에서도 화면은 떠야 해서 전부 try/catch

const TOKEN_KEY = "hibiscus.tokens";
const MOCK_KEY = "hibiscus.mock";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
}

let memoryTokens: StoredTokens | null = null;
let memoryMock: boolean | null = null;

export function loadTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (raw) return JSON.parse(raw) as StoredTokens;
  } catch {
    // 메모리 값 사용
  }
  return memoryTokens;
}

export function saveTokens(tokens: StoredTokens | null): void {
  memoryTokens = tokens;
  try {
    if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 무시
  }
}

// 붙여넣은 값이 콜백 JSON 전체면 access/refresh 둘 다 꺼냄
export function parsePastedTokens(access: string, refresh: string): StoredTokens | null {
  const text = access.trim();
  if (text.startsWith("{")) {
    try {
      const body = JSON.parse(text) as { access_token?: unknown; refresh_token?: unknown };
      if (typeof body.access_token === "string") {
        return {
          accessToken: body.access_token,
          refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (!text) return null;
  return { accessToken: text.replace(/^Bearer\s+/i, ""), refreshToken: refresh.trim() || null };
}

function urlMockFlag(): boolean | null {
  const read = (query: string) => {
    const value = new URLSearchParams(query).get("mock");
    if (value === null) return null;
    return value !== "0" && value !== "false";
  };
  const hashQuery = window.location.hash.split("?")[1] ?? "";
  return read(window.location.search) ?? read(hashQuery);
}

// 우선순위: URL ?mock= → 직접 고른 값 → 토큰 없으면 mock
export function isMockMode(): boolean {
  const fromUrl = urlMockFlag();
  if (fromUrl !== null) return fromUrl;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(MOCK_KEY);
  } catch {
    stored = memoryMock === null ? null : String(memoryMock);
  }
  if (stored === "true") return true;
  if (stored === "false" && loadTokens()) return false;
  return !loadTokens();
}

export function setMockMode(value: boolean): void {
  memoryMock = value;
  try {
    localStorage.setItem(MOCK_KEY, String(value));
  } catch {
    // 무시
  }
}
