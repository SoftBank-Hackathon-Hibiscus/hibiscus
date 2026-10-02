// 화면 라벨의 KO / JA. 선택한 언어 하나만 보여준다. 데이터 쪽의 reason_i18n / hint_i18n / explain.ja 도 같은 선택을 따른다.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'ko' | 'ja';
const STORAGE_KEY = 'hibiscus.lang';

const dict = {
  // 공통
  demoData: ['DEMO DATA', 'DEMO DATA'],
  backToDemo: ['데모 홈', 'デモホーム'],
  details: ['자세히 보기', '詳細を見る'],
  hideDetails: ['접기', '閉じる'],
  raw: ['원본 보기', '生データを見る'],
  copy: ['복사', 'コピー'],
  copied: ['복사됨', 'コピー済み'],
  none: ['없음', 'なし'],
  loading: ['불러오는 중', '読み込み中'],
  onprem: ['On-Prem', 'On-Prem'],
  cloud_run: ['Cloud Run', 'Cloud Run'],
  allow: ['허용', '許可'],
  denied: ['불가', '不可'],
  yes: ['예', 'はい'],
  no: ['아니오', 'いいえ'],
  // 연결 상태
  connChecking: ['연결 확인 중', '接続確認中'],
  connDown: ['백엔드 연결 안 됨', 'バックエンド未接続'],
  connLogin: ['로그인 필요', 'ログインが必要'],
  connOk: ['실제 백엔드 연결됨', '実バックエンドに接続中'],
  // 런처
  heroTitle: ['실제로 검증한 이미지를, 정책이 허용한 위치에', '実際に検証したイメージを、ポリシーが許可した場所へ'],
  heroSub1: ['재생 테스트로 확인한 이미지만 서명하고, 정책이 정한 위치에만 배포합니다.', '再生テストで確認したイメージだけに署名し、ポリシーが定めた場所にだけデプロイします。'],
  heroSub2: ['네 가지 상황을 골라 보세요.', '4つの状況から選んでください。'],
  s1Title: ['문제가 있는 앱', '問題のあるアプリ'],
  s1Line: ['재시작·교체 시 데이터 유실을 감지합니다', '再起動・入れ替え時のデータ消失を検知します'],
  s1Badge: ['BLOCK', 'BLOCK'],
  s2Title: ['수정한 앱', '修正したアプリ'],
  s2Line: ['검증을 통과한 이미지를 배포합니다', '検証を通過したイメージをデプロイします'],
  s2Badge: ['ON-PREM ACTIVE', 'ON-PREM ACTIVE'],
  s3Title: ['잘못된 후보 버전', '不良な候補バージョン'],
  s3Line: ['검사에 실패하면 트래픽을 바꾸지 않습니다', '検査に失敗したらトラフィックを切り替えません'],
  s3Badge: ['기존 서비스 유지', '既存サービス維持'],
  s4Title: ['온프레 장애', 'オンプレ障害'],
  s4Line: ['Cloud Run으로 자동 전환합니다', 'Cloud Runへ自動切り替えします'],
  s4Badge: ['FAILOVER', 'FAILOVER'],
  connectReal: ['실제 백엔드에 연결', '実バックエンドに接続'],
  connectStep1: ['backend-v2를 실행합니다. 개발 서버가 같은 origin으로 프록시합니다 (기본 http://127.0.0.1:8080).', 'backend-v2 を起動します。開発サーバーが同一オリジンにプロキシします（既定 http://127.0.0.1:8080）。'],
  connectStep2: ['GitHub 로그인 콜백 JSON의 access_token을 복사해 둡니다.', 'GitHub ログインのコールバック JSON にある access_token を控えます。'],
  connectStep3: ['real 모드로 열기', 'real モードで開く'],
  connectStep3b: ['연결 상태와 체크리스트가 그 화면에 있습니다.', '接続状態とチェックリストはその画面にあります。'],
  // 배포 상세
  deployment: ['배포', 'デプロイ'],
  stepTest: ['테스트', 'テスト'],
  stepPolicy: ['정책', 'ポリシー'],
  stepSign: ['서명', '署名'],
  stepDeploy: ['배포', 'デプロイ'],
  notRun: ['진행 안 함', '未実行'],
  pending: ['대기', '待機'],
  running: ['진행 중', '実行中'],
  done: ['완료', '完了'],
  passed: ['통과', '合格'],
  failed: ['실패', '失敗'],
  skipped: ['생략', 'スキップ'],
  blocked: ['차단', 'ブロック'],
  approvalNeeded: ['승인 필요', '承認が必要'],
  approved: ['승인됨', '承認済み'],
  signed: ['서명됨', '署名済み'],
  dryRun: ['모의 서명', '模擬署名'],
  held: ['보류', '保留'],
  rolledBack: ['복구됨', '復旧済み'],
  error: ['오류', 'エラー'],
  switchFailed: ['전환 실패', '切替失敗'],
  notStarted: ['시작 안 됨', '未開始'],
  policyDetail: ['정책 상세', 'ポリシー詳細'],
  testDetail: ['테스트 상세', 'テスト詳細'],
  signDetail: ['서명 상세', '署名詳細'],
  deployDetail: ['배포 상세', 'デプロイ詳細'],
  decision: ['결정', '判定'],
  targets: ['배포 위치', 'デプロイ先'],
  failover: ['Failover', 'Failover'],
  requires: ['고칠 것', '修正すべきこと'],
  nothingToFix: ['고칠 것이 없습니다.', '修正すべきことはありません。'],
  allowedAfterFix: ['해소되면 가능한 위치', '解消後に可能な場所'],
  matchedRules: ['걸린 규칙', '該当したルール'],
  afterBlock: ['차단 뒤에 걸림', 'ブロック後に該当'],
  passedRules: ['통과한 규칙', '通過したルール'],
  explain: ['결정 설명', '判定の説明'],
  explainOpen: ['결정 설명 보기', '判定の説明を見る'],
  policyDecision: ['정책 결정', 'ポリシー判定'],
  close: ['닫기', '閉じる'],
  pii: ['개인정보 후보', '個人情報候補'],
  piiNone: ['개인정보 후보 없음', '個人情報候補なし'],
  stubPolicy: ['stub 정책이라 규칙 이유, 설명 문서, 개인정보 판정이 없습니다.', 'スタブポリシーのためルール理由・説明文・個人情報判定はありません。'],
  planHash: ['결정 지문', '判定ハッシュ'],
  requestsMatched: ['요청 일치', 'リクエスト一致'],
  baselineNone: ['기준 조건 none', '基準条件 none'],
  mismatches: ['어긋난 요청', '不一致リクエスト'],
  mismatchIndex: ['#', '#'],
  request: ['요청', 'リクエスト'],
  relatedFact: ['관련 사실', '関連する事実'],
  kind: ['종류', '種類'],
  unknownCause: ['원인 미상', '原因不明'],
  testPassed: ['테스트 통과', 'テスト合格'],
  testFailed: ['테스트 실패', 'テスト失敗'],
  stubTest: ['fixture 템플릿으로 만든 stub 결과입니다. 실제 재생은 하지 않았습니다.', 'fixture テンプレートで作ったスタブ結果です。実際の再生は行っていません。'],
  db: ['DB', 'DB'],
  localFiles: ['로컬 파일 쓰기', 'ローカルファイル書き込み'],
  migration: ['마이그레이션', 'マイグレーション'],
  destructive: ['파괴적 변경', '破壊的変更'],
  safe: ['안전', '安全'],
  noTestResult: ['테스트 결과가 없습니다.', 'テスト結果がありません。'],
  signatureRefused: ['서명 거부', '署名拒否'],
  approver: ['승인자', '承認者'],
  requester: ['요청자', '依頼者'],
  signedAt: ['서명 시각', '署名日時'],
  signedTargets: ['서명된 배포 위치', '署名済みデプロイ先'],
  noSign: ['서명 결과가 없습니다.', '署名結果がありません。'],
  humanApproval: ['사람 승인', '人による承認'],
  awaitingApproval: ['승인 대기', '承認待ち'],
  approve: ['승인하기', '承認する'],
  approving: ['승인 중', '承認中'],
  selfApprovalNote: ['요청자 본인은 승인할 수 없습니다.', '依頼者本人は承認できません。'],
  approvedAt: ['승인 시각', '承認日時'],
  routing: ['트래픽 전환', 'トラフィック切替'],
  routeTarget: ['전환 대상', '切替先'],
  routeRevision: ['route revision', 'route revision'],
  standby: ['standby', 'standby'],
  active: ['활성', '有効'],
  inactive: ['비활성', '無効'],
  image: ['이미지', 'イメージ'],
  plannedTargets: ['계획된 위치', '計画された場所'],
  signatureCheck: ['서명 검증', '署名検証'],
  verified: ['검증됨', '検証済み'],
  unverified: ['미검증', '未検証'],
  startedAt: ['시작', '開始'],
  finishedAt: ['종료', '終了'],
  stepResults: ['단계별 결과', 'ステップ別結果'],
  target: ['대상', '対象'],
  phase: ['단계', 'フェーズ'],
  result: ['결과', '結果'],
  detail: ['상세', '詳細'],
  candidateChecks: ['후보 검사', '候補の検査'],
  pass: ['통과', '合格'],
  fail: ['실패', '失敗'],
  proofChain: ['증명 체인', '証明チェーン'],
  proofRun: ['같은 실행', '同じ実行'],
  proofSource: ['같은 커밋', '同じコミット'],
  proofDigest: ['같은 이미지', '同じイメージ'],
  proofPlan: ['같은 정책 결정', '同じポリシー判定'],
  proofOk: ['확인', '確認'],
  proofMismatch: ['불일치', '不一致'],
  proofPending: ['확인 전', '未確認'],
  proofUnverified: ['미검증', '未検証'],
  identifiers: ['식별자', '識別子'],
  runId: ['실행 ID', '実行 ID'],
  commit: ['커밋', 'コミット'],
  digest: ['이미지 digest', 'イメージ digest'],
  trigger: ['트리거', 'トリガー'],
  webhook: ['GitHub push', 'GitHub push'],
  manual: ['수동 요청', '手動リクエスト'],
  execMode: ['실행 모드', '実行モード'],
  createdAt: ['생성', '作成'],
  updatedAt: ['갱신', '更新'],
  auditLog: ['감사 기록', '監査ログ'],
  artifacts: ['산출물', '成果物'],
  items: ['건', '件'],
  time: ['시각', '日時'],
  content: ['내용', '内容'],
  rules: ['규칙', 'ルール'],
  stageSummary: ['단계 summary 원본', 'ステージ summary 生データ'],
  statusQueued: ['대기 중', '待機中'],
  statusRunning: ['진행 중', '実行中'],
  statusAwaiting: ['승인 대기', '承認待ち'],
  statusBlocked: ['정책 차단', 'ポリシーでブロック'],
  statusFailed: ['실패', '失敗'],
  statusSucceeded: ['완료', '完了'],
  deployed: ['배포됨', 'デプロイ済み'],
  notDeployed: ['배포 안 됨', '未デプロイ'],
  refreshing2s: ['2초마다 갱신', '2秒ごとに更新'],
  refreshing5s: ['5초마다 갱신', '5秒ごとに更新'],
  // 앱 상세
  application: ['애플리케이션', 'アプリケーション'],
  trafficNow: ['현재 트래픽 위치', '現在のトラフィック先'],
  status: ['상태', '状態'],
  failoverPolicy: ['Failover 정책', 'Failover ポリシー'],
  noRoute: ['경로 없음', '経路なし'],
  noRouteNote: ['첫 route 전환 전이라 트래픽을 받는 곳이 없습니다.', '最初の route 切替前のため、トラフィックを受ける場所がありません。'],
  trafficOn: ['지금 트래픽은 {target}에서 처리 중', '現在のトラフィックは {target} で処理中'],
  trafficFailedOver: ['온프레 장애로 Cloud Run에서 처리 중', 'オンプレ障害のため Cloud Run で処理中'],
  hereNow: ['지금 여기로', '今はこちら'],
  standbyFailover: ['대기 중, failover 대상', '待機中、failover 先'],
  standbyNoFailover: ['대기 중, failover 불가', '待機中、failover 不可'],
  waiting: ['대기', '待機'],
  manualAfterRecovery: ['복구 뒤 수동 전환', '復旧後に手動切替'],
  notRegistered: ['등록 안 됨', '未登録'],
  notRegisteredNote: ['{target} target이 등록되지 않았습니다.', '{target} target が登録されていません。'],
  healthy: ['정상', '正常'],
  unhealthy: ['응답 없음', '応答なし'],
  unknown: ['확인 중', '確認中'],
  noHealth: ['health 없음', 'health なし'],
  networkError: ['네트워크 오류', 'ネットワークエラー'],
  appError: ['앱 오류', 'アプリエラー'],
  consecutiveOk: ['연속 성공 {n}', '連続成功 {n}'],
  consecutiveFail: ['연속 실패 {n}', '連続失敗 {n}'],
  observationExpired: ['관측 만료', '観測期限切れ'],
  lastObserved: ['마지막 관측', '最終観測'],
  agent: ['에이전트', 'エージェント'],
  ports: ['포트', 'ポート'],
  serving: ['서빙 중', '稼働中'],
  lastSeen: ['마지막 접속', '最終接続'],
  noAgents: ['할당된 에이전트가 없어 상태 조회를 건너뜁니다.', '割り当てられたエージェントがないため状態照会を省略します。'],
  deployHistory: ['배포 이력', 'デプロイ履歴'],
  servingNow: ['서빙 중', '稼働中'],
  gateway: ['게이트웨이', 'ゲートウェイ'],
  failoverHappened: ['failover 발생', 'failover 発生'],
  routeChanged: ['route 변경', 'route 変更'],
  noFailback: ['자동 failback은 없습니다. 온프레가 복구되면 수동으로 route를 바꿉니다.', '自動 failback はありません。オンプレ復旧後は手動で route を切り替えます。'],
  changesSeen: ['이 화면에서 관측한 route 변경', 'この画面で観測した route 変更'],
  healthConfig: ['health {method} {path}, {interval}초마다, {threshold}회 실패면 전환', 'health {method} {path}、{interval}秒ごと、{threshold}回失敗で切替'],
  healthOff: ['health 검사 꺼짐', 'health 検査オフ'],
  // 연결 화면
  connectTitle: ['실제 백엔드에 연결', '実バックエンドに接続'],
  connectSub: ['세 가지가 차례로 준비되어야 화면이 실제 데이터를 보여줍니다.', '3つが順に準備できると画面が実データを表示します。'],
  backend: ['백엔드', 'バックエンド'],
  token: ['토큰', 'トークン'],
  pickApp: ['앱 선택', 'アプリ選択'],
  recheck: ['다시 확인', '再確認'],
  responds: ['응답함', '応答あり'],
  notConnected: ['연결 안 됨', '未接続'],
  backendFirst: ['백엔드 먼저', 'まずバックエンド'],
  tokenFirst: ['토큰 먼저', 'まずトークン'],
  tokenInvalid: ['유효하지 않음', '無効'],
  loginNeeded: ['로그인 필요', 'ログインが必要'],
  advanced: ['고급: id 직접 입력', '詳細: id を直接入力'],
  goto: ['이동', '移動'],
  noApps: ['등록된 애플리케이션이 없습니다. 백엔드에서 POST /applications 로 먼저 만드세요.', '登録されたアプリケーションがありません。バックエンドで POST /applications から作成してください。'],
  tokenSaved: ['토큰 저장됨', 'トークン保存済み'],
  change: ['바꾸기', '変更'],
  clear: ['지우기', '削除'],
  save: ['저장', '保存'],
  cancel: ['취소', 'キャンセル'],
  tokenPlaceholder: ['access_token 붙여넣기', 'access_token を貼り付け'],
  tokenExpired: ['토큰이 만료되었습니다. 새 토큰을 입력하세요', 'トークンの期限が切れました。新しいトークンを入力してください'],
  backendUnreachable: ['백엔드에 연결할 수 없습니다', 'バックエンドに接続できません'],
  requestFailed: ['요청 실패', 'リクエスト失敗'],
} as const;

export type DictKey = keyof typeof dict;

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: DictKey, params?: Record<string, string | number>) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

function readLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ja' ? 'ja' : 'ko';
  } catch {
    return 'ko';
  }
}

export function translate(lang: Lang, key: DictKey, params?: Record<string, string | number>): string {
  const pair = dict[key];
  let text: string = lang === 'ja' ? pair[1] : pair[0];
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v));
  return text;
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 저장 못 해도 세션 동안은 유지
    }
  }, []);
  const value = useMemo<LangContextValue>(() => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('LangProvider 밖에서 useLang 을 호출함');
  return ctx;
}

/** reason / hint 처럼 ko 문자열 + 선택적 ja 를 가진 값에서 현재 언어를 고른다. ja 가 없으면 ko. */
export function pickLang(lang: Lang, ko: string | undefined, i18n?: { ja?: string }): string | undefined {
  if (lang === 'ja' && i18n?.ja) return i18n.ja;
  return ko;
}
