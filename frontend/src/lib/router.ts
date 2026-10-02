import { useEffect, useState } from 'react';

export type Route =
  | { page: 'deployment'; id: string }
  | { page: 'application'; id: string }
  | { page: 'none' };

export function parseHash(hash: string = window.location.hash): Route {
  const path = hash.replace(/^#/, '');
  let match = /^\/deployments\/([^/?#]+)/.exec(path);
  if (match?.[1]) return { page: 'deployment', id: decodeURIComponent(match[1]) };
  match = /^\/applications\/([^/?#]+)/.exec(path);
  if (match?.[1]) return { page: 'application', id: decodeURIComponent(match[1]) };
  return { page: 'none' };
}

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
