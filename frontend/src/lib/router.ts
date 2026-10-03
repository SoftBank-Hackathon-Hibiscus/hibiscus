import { useEffect, useState } from 'react';

export type Route =
  | { page: 'deployment'; id: string }
  | { page: 'application'; id: string }
  | { page: 'applications' }
  | { page: 'register' }
  | { page: 'connect' }
  /** 서비스 첫 화면. section 은 홈 안의 특정 부분으로 스크롤할 때 (예: 데모 시나리오) */
  | { page: 'home'; section?: 'demos' };

export function parseHash(hash: string = window.location.hash): Route {
  const path = hash.replace(/^#/, '');
  let match = /^\/deployments\/([^/?#]+)/.exec(path);
  if (match?.[1]) return { page: 'deployment', id: decodeURIComponent(match[1]) };
  if (/^\/applications\/new\/?$/.test(path)) return { page: 'register' };
  match = /^\/applications\/([^/?#]+)/.exec(path);
  if (match?.[1]) return { page: 'application', id: decodeURIComponent(match[1]) };
  if (/^\/applications\/?$/.test(path)) return { page: 'applications' };
  if (/^\/connect\/?$/.test(path)) return { page: 'connect' };
  if (/^\/demos\/?$/.test(path)) return { page: 'home', section: 'demos' };
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

/** 현재 query string(mode, scenario)을 유지한 채 해시만 바꾼 링크 */
export function hrefFor(path: string, search: string = window.location.search): string {
  return `${search}#${path}`;
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
