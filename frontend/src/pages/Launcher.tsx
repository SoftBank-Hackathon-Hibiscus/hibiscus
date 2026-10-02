import { ArrowRight, CloudOff, PackageCheck, ShieldAlert, ShieldX, UserCheck } from 'lucide-react';
import { configToSearch } from '../api';
import { Collapsible, IconTile, PageTitle } from '../components/ui';
import { useLang, type DictKey } from '../lib/i18n';
import { scenarioSummaries, type ScenarioId } from '../mocks';
import type { Tone } from '../lib/deployState';

interface CardCopy {
  id: ScenarioId;
  icon: typeof ShieldX;
  tone: Tone;
  title: DictKey;
  line: DictKey;
  badge: DictKey;
}

const CARDS: CardCopy[] = [
  { id: 1, icon: ShieldX, tone: 'danger', title: 's1Title', line: 's1Line', badge: 's1Badge' },
  { id: 2, icon: PackageCheck, tone: 'success', title: 's2Title', line: 's2Line', badge: 's2Badge' },
  { id: 3, icon: ShieldAlert, tone: 'warning', title: 's3Title', line: 's3Line', badge: 's3Badge' },
  { id: 4, icon: CloudOff, tone: 'warning', title: 's4Title', line: 's4Line', badge: 's4Badge' },
  { id: 5, icon: UserCheck, tone: 'warning', title: 's5Title', line: 's5Line', badge: 's5Badge' },
];

/** mock 시나리오를 고르는 얇은 시작판. 앱 관리 기능이 아니다. */
export function Launcher() {
  const { t } = useLang();
  const paths = new Map(scenarioSummaries().map((s) => [s.id, s.defaultPath]));
  return (
    <div className="page launcher">
      <PageTitle
        title={t('heroTitle')}
        sub={
          <>
            <span className="line">{t('heroSub1')}</span>
            <span className="line">{t('heroSub2')}</span>
          </>
        }
      />
      <div className="launch-grid">
        {CARDS.map((card) => (
          <a key={card.id} className="card launch-card" href={`${configToSearch({ mode: 'mock', scenario: card.id })}#${paths.get(card.id) ?? ''}`}>
            <IconTile icon={card.icon} tone={card.tone} size={36} />
            <span className="launch-title">{t(card.title)}</span>
            <span className="launch-line">{t(card.line)}</span>
            <span className="launch-foot">
              <span className={`pill pill-${card.tone}`}>
                <span className="pill-dot" aria-hidden />
                {t(card.badge)}
              </span>
              <ArrowRight size={16} className="launch-arrow" aria-hidden />
            </span>
          </a>
        ))}
      </div>
      <section className="card card-collapsed">
        <Collapsible title={t('connectReal')}>
          <ol className="steps-list">
            <li>{t('connectStep1')}</li>
            <li>{t('connectStep2')}</li>
            <li>
              <a href={`${configToSearch({ mode: 'real', scenario: 1 })}#`}>{t('connectStep3')}</a>. {t('connectStep3b')}
            </li>
          </ol>
        </Collapsible>
      </section>
    </div>
  );
}
