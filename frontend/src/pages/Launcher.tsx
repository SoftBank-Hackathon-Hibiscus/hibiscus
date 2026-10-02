import { configToSearch } from '../api';
import { scenarioSummaries, type ScenarioId } from '../mocks';
import { Collapsible } from '../components/ui';

interface CardCopy {
  id: ScenarioId;
  title: string;
  line: string;
  badge: string;
  tone: 'success' | 'warning' | 'danger';
}

const CARDS: CardCopy[] = [
  { id: 1, title: '문제가 있는 앱', line: '재시작·교체 시 데이터 유실을 감지합니다', badge: 'BLOCK, 수정 필요', tone: 'danger' },
  { id: 2, title: '수정한 앱', line: '검증을 통과한 이미지를 배포합니다', badge: 'ON-PREM ACTIVE', tone: 'success' },
  { id: 3, title: '잘못된 후보 버전', line: '검사에 실패하면 트래픽을 바꾸지 않습니다', badge: '기존 서비스 유지', tone: 'warning' },
  { id: 4, title: '온프레 장애', line: 'Cloud Run으로 자동 전환합니다', badge: 'FAILOVER', tone: 'warning' },
];

/** mock 시나리오를 고르는 얇은 시작판. 앱 관리 기능이 아니다. */
export function Launcher() {
  const paths = new Map(scenarioSummaries().map((s) => [s.id, s.defaultPath]));
  return (
    <div className="launcher">
      <header className="launcher-hero">
        <h1>Hibiscus</h1>
        <p className="tagline">실제로 검증한 이미지를, 정책이 허용한 위치에 배포합니다</p>
      </header>
      <div className="launcher-grid">
        {CARDS.map((card) => (
          <a key={card.id} className={`launch-card launch-${card.tone}`} href={`${configToSearch({ mode: 'mock', scenario: card.id })}#${paths.get(card.id) ?? ''}`}>
            <span className="launch-index">{card.id}</span>
            <span className="launch-title">{card.title}</span>
            <span className="launch-line">{card.line}</span>
            <span className="launch-badge">{card.badge}</span>
          </a>
        ))}
      </div>
      <section className="launcher-real">
        <Collapsible title="실제 백엔드에 연결">
          <ol className="steps-list">
            <li>backend-v2를 실행합니다. 개발 서버가 같은 origin으로 프록시합니다 (기본 http://127.0.0.1:8080).</li>
            <li>GitHub 로그인 콜백 JSON의 access_token을 복사해 둡니다.</li>
            <li>
              <a href={`${configToSearch({ mode: 'real', scenario: 1 })}#`}>real 모드로 열기</a>. 연결 상태와 체크리스트가 그 화면에 있습니다.
            </li>
          </ol>
        </Collapsible>
      </section>
    </div>
  );
}
