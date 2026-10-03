import { useEffect, useState } from 'react';

export type Route =
  | { page: 'deployment'; id: string }
  | { page: 'application'; id: string }
  | { page: 'applications' }
  | { page: 'register' }
  | { page: 'connect' }
  /** 데모 시나리오 선택 화면 */
  | { page: 'demos' }
  | { page: 'home' };

export function parseHash(hash: string = window.location.hash): Route {
  const path = hash.replace(/^#/, '');
  let match = /^\/deployments\/([^/?#]+)/.exec(path);
  if (match?.[1]) return { page: 'deployment', id: decodeURIComponent(match[1]) };
  if (/^\/applications\/new\/?$/.test(path)) return { page: 'register' };
  match = /^\/applications\/([^/?#]+)/.exec(path);
  if (match?.[1]) return { page: 'application', id: decodeURIComponent(match[1]) };
  if (/^\/applications\/?$/.test(path)) return { page: 'applications' };
  if (/^\/connect\/?$/.test(path)) return { page: 'connect' };
  if (/^\/demos\/?$/.test(path)) return { page: 'demos' };
  return { page: 'home' };
}

export const HOME_PATH = '/';
export const DEMOS_PATH = '/demos';
export const CONNECT_PATH = '/connect';
export const APPLICATIONS_PATH = '/applications';
export const REGISTER_PATH = '/applications/new';

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/**
 * 현재 query string(mode, scenario)을 유지한 채 해시만 바꾼 링크.
 * 데모 안에서 같은 시나리오의 다른 화면(앱 ↔ 배포)으로 갈 때 쓴다.
 */
export function hrefFor(path: string, search: string = window.location.search): string {
  return `${search}#${path}`;
}

/**
 * 일반 서비스 영역(홈·앱 목록·로그인·데모 목록)으로 가는 링크. query 를 모두 떼어 real 모드로 돌아간다.
 * mock query 가 서비스 navigation 에 따라붙지 않게 하는 유일한 통로다.
 */
export function realHref(path: string): string {
  return `${window.location.pathname}#${path}`;
}

/** 데모 시나리오 N 의 화면을 여는 링크. mode/scenario 를 명시한다. */
export function mockHref(scenario: number, path: string): string {
  return `${window.location.pathname}?mode=mock&scenario=${scenario}#${path}`;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function deploymentPath(id: string): string {
  return `/deployments/${encodeURIComponent(id)}`;
}

export function applicationPath(id: string): string {
  return `/applications/${encodeURIComponent(id)}`;
}
