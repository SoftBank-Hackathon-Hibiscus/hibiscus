import { ExternalLink } from 'lucide-react';
import { useLang } from '../lib/i18n';

/** A separate recorded case, never the diagnosis of the displayed deployment. */
export function RecordedDiagnosis({ relatedCase = false }: { relatedCase?: boolean }) {
  const { lang, t } = useLang();
  return (
    <div className="stack-sm">
      <div className="row">
        <a className="btn btn-small" href={`${import.meta.env.BASE_URL}diagnosis/guestbook.html?lang=${lang}`} target="_blank" rel="noopener noreferrer" title={t('diagnosisNewTab')}>
          {t(relatedCase ? 'diagnosisRelatedAction' : 'diagnosisRecordedAction')}
          <ExternalLink size={13} aria-hidden />
        </a>
      </div>
      <p className="small muted">{t('diagnosisRecordedNote')}</p>
    </div>
  );
}
