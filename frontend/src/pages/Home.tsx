import { FlaskConical, Lock, Rocket, Scale, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { configToSearch } from '../api';
import type { ConnectionState } from '../hooks/useConnection';
import { usePageTitle } from '../hooks/usePageTitle';
import { useLang, type DictKey } from '../lib/i18n';
import { APPLICATIONS_PATH, CONNECT_PATH, DEMOS_PATH, hrefFor, type Route } from '../lib/router';
import { scenarioSummaries, type ScenarioId } from '../mocks';
import type { Tone } from '../lib/deployState';

interface FlowStep {
  icon: LucideIcon;
  title: DictKey;
  line: DictKey;
}

const FLOW: FlowStep[] = [
  { icon: FlaskConical, title: 'flowTestTitle', line: 'flowTestLine' },
  { icon: Scale, title: 'flowPolicyTitle', line: 'flowPolicyLine' },
  { icon: Lock, title: 'flowSignTitle', line: 'flowSignLine' },
  { icon: Rocket, title: 'flowDeployTitle', line: 'flowDeployLine' },
];

const PILLARS: Array<{ title: DictKey; body: DictKey }> = [
  { title: 'pillarProofTitle', body: 'pillarProofBody' },
  { title: 'pillarRulesTitle', body: 'pillarRulesBody' },
  { title: 'pillarSwitchTitle', body: 'pillarSwitchBody' },
];

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
 * 서비스 첫 화면. mock/real 어느 모드에서나 같은 소개를 보여주고, 데모 시나리오는 아래 섹션에 둔다.
 * 데모 링크는 항상 mock 모드로, "실제 환경 연결"은 real 모드의 연결 화면으로 간다.
 */
export function Home({ isReal, connection, route }: { isReal: boolean; connection: ConnectionState; route: Route }) {
  const { t } = useLang();
  usePageTitle(null);
  const paths = new Map(scenarioSummaries().map((s) => [s.id, s.defaultPath]));
  const connected = isReal && connection.level === 'ok';
  const demosHref = isReal ? `${configToSearch({ mode: 'mock', scenario: 1 })}#${DEMOS_PATH}` : hrefFor(DEMOS_PATH);
  const connectHref = isReal ? hrefFor(CONNECT_PATH) : `${configToSearch({ mode: 'real', scenario: 1 })}#${CONNECT_PATH}`;

  // #/demos 로 들어오면 데모 섹션으로 내려간다
  useEffect(() => {
    if (route.page !== 'home' || route.section !== 'demos') return;
    const el = document.getElementById('demos');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [route]);

  return (
    <div className="page home">
      <section className="hero">
        <h1 className="hero-title">{t('homeTitle')}</h1>
        <p className="hero-sub">{t('homeSub')}</p>
        <div className="hero-cta">
          <a className="btn btn-primary btn-large" href={demosHref}>
            {t('homeCtaDemo')}
          </a>
          {connected ? (
            <a className="btn btn-large" href={hrefFor(APPLICATIONS_PATH)}>
              {t('homeCtaApps')}
            </a>
          ) : (
            <a className="btn btn-large" href={connectHref}>
              {t('connectLink')}
            </a>
          )}
        </div>
      </section>

      <section className="flow" aria-label={t('flowTitle')}>
        <ol className="flow-track">
          {FLOW.map(({ icon: Icon, title, line }) => (
            <li key={title} className="flow-item">
              <span className="flow-mark" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="flow-title">{t(title)}</span>
              <span className="flow-line">{t(line)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="pillars-section">
        <div className="section-head">
          <h2>{t('pillarsTitle')}</h2>
        </div>
        <div className="pillars">
          {PILLARS.map(({ title, body }) => (
            <div key={title} className="pillar">
              <h3>{t(title)}</h3>
              <p>{t(body)}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="demos" className="demos">
        <div className="section-head">
          <h2>{t('demosTitle')}</h2>
          <p>{t('demosSub')}</p>
        </div>
        <div className="demo-grid">
          {SCENARIOS.map((card) => (
            <a key={card.id} className="card demo-card" href={`${configToSearch({ mode: 'mock', scenario: card.id })}#${paths.get(card.id) ?? ''}`}>
              <span className="demo-card-title">{t(card.title)}</span>
              <span className="demo-card-line">{t(card.line)}</span>
              <span className="demo-card-foot">
                <span className={`pill pill-${card.tone}`}>
                  <span className="pill-dot" aria-hidden />
                  {t(card.badge)}
                </span>
                <span className="demo-tag">{t('statusDemo')}</span>
              </span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
