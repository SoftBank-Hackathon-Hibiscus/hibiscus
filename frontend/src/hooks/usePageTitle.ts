import { useEffect } from 'react';

const BRAND = 'Hibiscus';

/** 브라우저 탭 제목. null 이면 브랜드만, 아니면 "<title> · Hibiscus". 화면을 떠나면 브랜드로 되돌린다. */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BRAND}` : BRAND;
    return () => {
      document.title = BRAND;
    };
  }, [title]);
}
