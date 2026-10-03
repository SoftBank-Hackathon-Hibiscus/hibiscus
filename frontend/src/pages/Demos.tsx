import { Notice, PageTitle, Pill } from '../components/ui';
import type { Tone } from '../lib/deployState';
import { useLang, type DictKey } from '../lib/i18n';
import { HOME_PATH, mockHref, realHref } from '../lib/router';
import { scenarioSummaries, type ScenarioId } from '../mocks';

interface CardCopy {
  id: ScenarioId;
  tone: Tone;
  title: DictKey;
  line: DictKey;
  badge: DictKey;
}

const SCENARIOS: CardCopy[] = [
  { id: 1, tone: 'danger', title: 's1Title', line: 's1Line', badge: 's1Badge' },
  { id: 2, tone: 'success', title: 's2Title', line: 's2Line', badge: 's2Badge' },
  { id: 3, tone: 'warning', title: 's3Title', line: 's3Line', badge: 's3Badge' },
  { id: 4, tone: 'warning', title: 's4Title', line: 's4Line', badge: 's4Badge' },
  { id: 5, tone: 'warning', title: 's5Title', line: 's5Line', badge: 's5Badge' },
];

/**
 * 데모 시나리오 선택. 실제 서비스와 분리된 공간이라 DEMO 표시를 앞에 둔다.
 * 각 카드는 `?mode=mock&scenario=N` 을 명시해 기존 mock 상세 화면을 연다. 홈으로 가는 링크는 query 를 뗀다.
 */
export function Demos() {
  const { t } = useLang();
  const paths = new Map(scenarioSummaries().map((s) => [s.id, s.defaultPath]));
  return (
    <div className="page demos-page">
      <PageTitle
        title={
          <span className="row row-tight">
            <Pill tone="warning">DEMO</Pill>
            {t('demosTitle')}
          </span>
        }
        sub={t('demosSub')}
      />
      <Notice tone="warning">{t('demosNote')}</Notice>
      <div className="demo-grid">
        {SCENARIOS.map((card) => (
          <a key={card.id} className="card demo-card" href={mockHref(card.id, paths.get(card.id) ?? '/')}>
            <span className="demo-card-title">{t(card.title)}</span>
            <span className="demo-card-line">{t(card.line)}</span>
            <span className="demo-card-foot">
              <span className={`pill pill-${card.tone}`}>
                <span className="pill-dot" aria-hidden />
                {t(card.badge)}
              </span>
              <span className="demo-tag">DEMO</span>
            </span>
          </a>
        ))}
      </div>
      <p className="small">
        <a href={realHref(HOME_PATH)}>{t('backToService')}</a>
      </p>
    </div>
  );
}
