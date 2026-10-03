import { FlaskConical, Lock, Rocket, Scale, Shuffle, type LucideIcon } from 'lucide-react';
import { Notice } from '../components/ui';
import type { ConnectionState } from '../hooks/useConnection';
import { useLang, type DictKey } from '../lib/i18n';
import { APPLICATIONS_PATH, CONNECT_PATH, DEMOS_PATH, realHref } from '../lib/router';

interface PipelineStep {
  icon: LucideIcon;
  title: DictKey;
  line: DictKey;
}

const PIPELINE: PipelineStep[] = [
  { icon: FlaskConical, title: 'pipeVerifyTitle', line: 'pipeVerifyLine' },
  { icon: Scale, title: 'pipePolicyTitle', line: 'pipePolicyLine' },
  { icon: Lock, title: 'pipeSignTitle', line: 'pipeSignLine' },
  { icon: Rocket, title: 'pipeDeployTitle', line: 'pipeDeployLine' },
  { icon: Shuffle, title: 'pipeFailoverTitle', line: 'pipeFailoverLine' },
];

/**
 * 서비스 첫 화면. 중앙 hero 와 CTA 두 개, 아래에 배포 흐름 pipeline 하나.
 * 데이터는 보여주지 않는다 (애플리케이션은 /applications 에서만). 연결 문제가 있을 때만 알림 한 줄.
 * pipeline 의 움직임은 장식이며 실제 배포 상태와 무관하다. prefers-reduced-motion 이면 멈춘다.
 */
export function Home({ isReal, connection }: { isReal: boolean; connection: ConnectionState }) {
  const { t } = useLang();
  const signedIn = isReal && connection.level === 'ok';
  const appsHref = realHref(signedIn ? APPLICATIONS_PATH : CONNECT_PATH);

  return (
    <div className="home">
      <div className="home-glow" aria-hidden />
      <section className="hero">
        {isReal && connection.level === 'down' && (
          <div className="hero-notice">
            <Notice tone="danger" title={t('errOfflineTitle')}>
              {t('errOfflineBody')} <a href={realHref(CONNECT_PATH)}>{t('checkConnection')}</a>
            </Notice>
          </div>
        )}
        <h1 className="hero-title">
          <span className="hero-line">{t('heroLine1')}</span>
          <span className="hero-line">{t('heroLine2')}</span>
        </h1>
        <p className="hero-sub">{t('heroSub')}</p>
        <div className="hero-cta">
          <a className="btn btn-primary btn-large" href={appsHref}>
            {t('homeCtaApps')}
          </a>
          <a className="btn btn-quiet btn-large" href={realHref(DEMOS_PATH)}>
            {t('homeCtaDemo')}
          </a>
        </div>
      </section>

      <section className="pipeline" aria-label={t('pipelineTitle')}>
        <ol className="pipeline-track">
          <span className="pipeline-line" aria-hidden>
            <span className="pipeline-pulse" />
          </span>
          {PIPELINE.map(({ icon: Icon, title, line }) => (
            <li key={title} className="pipeline-step">
              <span className="pipeline-mark" aria-hidden>
                <Icon size={16} />
              </span>
              <span className="pipeline-text">
                <span className="pipeline-title">{t(title)}</span>
                <span className="pipeline-line-text">{t(line)}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
