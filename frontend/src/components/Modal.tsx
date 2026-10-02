import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useLang } from '../lib/i18n';

/** 가운데 모달. X, 바깥 클릭, Esc 로 닫힌다. 열려 있는 동안 뒤는 흐려진다. */
export function Modal({ title, onClose, children, toolbar }: { title: ReactNode; onClose: () => void; children: ReactNode; toolbar?: ReactNode }) {
  const { t } = useLang();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <div className="modal-tools">
            {toolbar}
            <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
