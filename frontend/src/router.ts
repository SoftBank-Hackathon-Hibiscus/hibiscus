import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "application"; id: string }
  | { name: "deployment"; id: string }
  | { name: "connect" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "applications" && parts[1]) return { name: "application", id: parts[1] };
  if (parts[0] === "deployments" && parts[1]) return { name: "deployment", id: parts[1] };
  if (parts[0] === "connect") return { name: "connect" };
  return { name: "home" };
}

export const href = {
  home: () => "#/",
  application: (id: string) => `#/applications/${encodeURIComponent(id)}`,
  deployment: (id: string) => `#/deployments/${encodeURIComponent(id)}`,
  connect: () => "#/connect",
};

// 정적 파일로 배포해도 동작하도록 해시 경로만 사용
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
