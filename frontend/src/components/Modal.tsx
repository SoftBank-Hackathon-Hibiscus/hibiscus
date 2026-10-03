import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from '../lib/i18n';
import { prefersReducedMotion } from '../lib/motion';

// styles.css 의 modal-out / backdrop-out 길이와 맞춘다
const CLOSE_MS = 200;

/**
 * 가운데 모달. document.body 에 포털로 렌더해서 카드의 backdrop-filter 가 만든 containing block 에 갇히지 않는다.
 * X, Esc, backdrop 클릭으로 닫히고 모달 내부 클릭은 닫지 않는다. 열려 있는 동안 body 스크롤을 잠근다.
 */
export function Modal({ title, onClose, children, toolbar }: { title: ReactNode; onClose: () => void; children: ReactNode; toolbar?: ReactNode }) {
  const { t } = useLang();
  const closeRef = useRef<HTMLButtonElement>(null);
  // 닫을 때는 바로 내리지 않고 닫히는 애니메이션이 끝난 뒤 onClose 를 부른다
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => {
    if (prefersReducedMotion()) onClose();
    else setClosing(true);
  }, [onClose]);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClose, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKey);
    // html 과 body 둘 다 잠가야 뒤 페이지가 휠·키보드로 움직이지 않는다
    const root = document.documentElement;
    const previous = { html: root.style.overflow, body: document.body.style.overflow };
    root.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      root.style.overflow = previous.html;
      document.body.style.overflow = previous.body;
    };
  }, [requestClose]);

  return createPortal(
    <div className={`modal-backdrop${closing ? ' is-closing' : ''}`} onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <div className="modal-tools">
            {toolbar}
            <button ref={closeRef} type="button" className="icon-btn" onClick={requestClose} aria-label={t('close')}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="modal-body" tabIndex={0}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
