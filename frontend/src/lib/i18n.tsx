// 화면 라벨의 KO / JA. 선택한 언어 하나만 보여준다. 사람이 읽는 말로 쓰고, 내부 용어는 "세부 기술 정보" 안에서만 쓴다.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'ko' | 'ja';
const STORAGE_KEY = 'hibiscus.lang';

const dict = {
  // 공통
  demoData: ['DEMO DATA', 'DEMO DATA'],
  backToDemo: ['데모 홈', 'デモホーム'],
  techDetails: ['세부 기술 정보', '技術的な詳細'],
  hideDetails: ['접기', '閉じる'],
  copy: ['복사', 'コピー'],
  none: ['없음', 'なし'],
  loading: ['불러오는 중', '読み込み中'],
  onprem: ['On-Prem', 'On-Prem'],
  cloud_run: ['Cloud Run', 'Cloud Run'],
  yes: ['예', 'はい'],
  no: ['아니오', 'いいえ'],
  close: ['닫기', '閉じる'],
  // 연결 상태
  connChecking: ['연결 확인 중', '接続確認中'],
  connDown: ['백엔드 연결 안 됨', 'バックエンド未接続'],
  connLogin: ['로그인 필요', 'ログインが必要'],
  connOk: ['실제 백엔드 연결됨', '実バックエンドに接続中'],
  // 런처
  heroTitle: ['실제로 검증한 이미지를, 정책이 허용한 위치에', '実際に検証したイメージを、ポリシーが許可した場所へ'],
  heroSub1: ['재생 테스트로 확인한 이미지만 서명하고, 정책이 정한 위치에만 배포합니다.', '再生テストで確認したイメージだけに署名し、ポリシーが定めた場所にだけデプロイします。'],
  heroSub2: ['다섯 가지 상황을 골라 보세요.', '5つの状況から選んでください。'],
  s1Title: ['문제가 있는 앱', '問題のあるアプリ'],
  s1Line: ['재시작하면 데이터가 사라지는 앱을 배포 전에 찾아냅니다', '再起動でデータが消えるアプリをデプロイ前に見つけます'],
  s1Badge: ['BLOCK', 'BLOCK'],
  s2Title: ['수정한 앱', '修正したアプリ'],
  s2Line: ['검증을 통과한 이미지를 그대로 서명하고 배포합니다', '検証を通過したイメージをそのまま署名してデプロイします'],
  s2Badge: ['ON-PREM ACTIVE', 'ON-PREM ACTIVE'],
  s3Title: ['잘못된 후보 버전', '不良な候補バージョン'],
  s3Line: ['새 버전이 검사에 실패하면 트래픽을 옮기지 않습니다', '新バージョンが検査に失敗したらトラフィックを切り替えません'],
  s3Badge: ['기존 서비스 유지', '既存サービス維持'],
  s4Title: ['온프레 장애', 'オンプレ障害'],
  s4Line: ['사내 서버가 멈추면 Cloud Run으로 자동 전환합니다', '社内サーバーが止まると Cloud Run へ自動切り替えします'],
  s4Badge: ['FAILOVER', 'FAILOVER'],
  s5Title: ['승인이 필요한 앱', '承認が必要なアプリ'],
  s5Line: ['개인정보일 수 있는 데이터가 있어 사람이 승인한 뒤 사내 서버에만 배포합니다', '個人情報かもしれないデータがあり、人が承認した後に社内サーバーにだけデプロイします'],
  s5Badge: ['NEEDS_APPROVAL', 'NEEDS_APPROVAL'],
  failOnprem: ['On-Prem 장애 발생', 'On-Prem 障害を発生させる'],
  resetScenario: ['처음 상태로', '最初の状態に戻す'],
  demoControls: ['발표 조작 (mock 전용)', 'デモ操作（mock 専用）'],
  connectReal: ['실제 백엔드에 연결', '実バックエンドに接続'],
  connectStep1: ['backend-v2를 실행합니다. 개발 서버가 같은 origin으로 프록시합니다 (기본 http://127.0.0.1:8080).', 'backend-v2 を起動します。開発サーバーが同一オリジンにプロキシします（既定 http://127.0.0.1:8080）。'],
  connectStep2: ['GitHub 로그인 콜백 JSON의 access_token을 복사해 둡니다.', 'GitHub ログインのコールバック JSON にある access_token を控えます。'],
  connectStep3: ['real 모드로 열기', 'real モードで開く'],
  connectStep3b: ['연결 상태와 체크리스트가 그 화면에 있습니다.', '接続状態とチェックリストはその画面にあります。'],
  // 배포 상세: 단계
  deployment: ['배포', 'デプロイ'],
  stepTest: ['테스트', 'テスト'],
  stepPolicy: ['정책', 'ポリシー'],
  stepSign: ['서명', '署名'],
  stepDeploy: ['배포', 'デプロイ'],
  resultTestPassed: ['모든 조건에서 결과가 같았어요', 'すべての条件で結果が同じでした'],
  resultTestFailed: ['재시작·교체에서 결과가 달라졌어요', '再起動・入れ替えで結果が変わりました'],
  resultTestFailedGeneric: ['기대한 결과와 달랐어요', '期待した結果と違いました'],
  resultAllow: ['배포를 허용했어요', 'デプロイを許可しました'],
  resultBlock: ['배포를 막았어요', 'デプロイを止めました'],
  resultNeedsApproval: ['사람의 승인이 필요해요', '人の承認が必要です'],
  resultApproved: ['승인을 받았어요', '承認されました'],
  resultSigned: ['서명했어요', '署名しました'],
  resultDryRun: ['모의로 서명했어요', '模擬署名しました'],
  resultRefused: ['서명을 거부했어요', '署名を拒否しました'],
  resultDeployed: ['트래픽을 옮겼어요', 'トラフィックを切り替えました'],
  resultHeld: ['트래픽을 옮기지 않았어요', 'トラフィックを切り替えませんでした'],
  resultRolledBack: ['이전 버전으로 되돌렸어요', '前のバージョンに戻しました'],
  resultError: ['오류로 멈췄어요', 'エラーで止まりました'],
  resultSwitchFailed: ['새 버전은 떴지만 전환에 실패했어요', '新バージョンは起動しましたが切替に失敗しました'],
  resultSkipped: ['이번에는 건너뛰었어요', '今回はスキップしました'],
  resultRunning: ['진행 중이에요', '実行中です'],
  resultPending: ['아직 시작 전이에요', 'まだ始まっていません'],
  notRunBlocked: ['정책에서 막혀 진행하지 않았어요', 'ポリシーで止まり実行しませんでした'],
  notRunEarlier: ['앞 단계에서 멈춰 진행하지 않았어요', '前の段階で止まり実行しませんでした'],
  notRunGate: ['배포 조건이 맞지 않아 시작하지 않았어요', 'デプロイ条件を満たさず開始しませんでした'],
  // 배포 상세: 상단 stepper 의 짧은 결과
  stepApproval: ['승인', '承認'],
  shortNotRun: ['미실행', '未実行'],
  shortPending: ['대기', '待機'],
  shortRunning: ['진행 중', '実行中'],
  shortAuto: ['자동', '自動'],
  shortApproved: ['승인됨', '承認済み'],
  shortAwaiting: ['승인 대기', '承認待ち'],
  shortSigned: ['서명됨', '署名済み'],
  shortDryRun: ['모의 서명', '模擬署名'],
  shortRefused: ['거부', '拒否'],
  shortDeployed: ['완료', '完了'],
  shortHeld: ['보류', '保留'],
  shortRolledBack: ['복구', '復旧'],
  shortError: ['오류', 'エラー'],
  shortSkipped: ['생략', 'スキップ'],
  shortSwitchFailed: ['전환 실패', '切替失敗'],
  shortPassed: ['통과', '合格'],
  shortFailed: ['실패', '失敗'],
  signAndDeploy: ['서명과 배포', '署名とデプロイ'],
  // 배포 상세: 패널
  policyDetail: ['정책 판단', 'ポリシー判定'],
  testDetail: ['테스트 결과', 'テスト結果'],
  signDetail: ['서명', '署名'],
  deployDetail: ['배포 결과', 'デプロイ結果'],
  decision: ['결정', '判定'],
  targets: ['배포 가능한 위치', 'デプロイできる場所'],
  failoverLabel: ['장애 시 자동 전환', '障害時の自動切替'],
  failoverOn: ['함', 'する'],
  failoverOff: ['안 함', 'しない'],
  failoverWhyBlocked: ['배포를 막았기 때문', 'デプロイを止めたため'],
  failoverWhyOneTarget: ['배포 위치가 하나뿐이라 옮길 곳이 없음', 'デプロイ先が1つだけで移す先がない'],
  failoverWhyPolicy: ['정책에서 끔', 'ポリシーで無効'],
  whyTitle: ['왜 이런 결정인가요', 'なぜこの判定か'],
  requires: ['고칠 것', '修正すべきこと'],
  nothingToFix: ['고칠 것이 없어요.', '修正すべきことはありません。'],
  fixUnlocks: ['고치면 배포 가능', '修正後にデプロイ可能'],
  fixUnlocksNone: ['고쳐도 다른 조건이 남아 있어요', '修正しても他の条件が残ります'],
  approvalTitle: ['사람 승인', '人による承認'],
  awaitingApproval: ['승인을 기다리는 중', '承認待ち'],
  approved: ['승인됨', '承認済み'],
  approve: ['승인하기', '承認する'],
  approving: ['승인 중', '承認中'],
  selfApprovalNote: ['요청한 사람은 직접 승인할 수 없어요.', '依頼した本人は承認できません。'],
  requester: ['요청한 사람', '依頼者'],
  approver: ['승인한 사람', '承認者'],
  approvedAt: ['승인 시각', '承認日時'],
  explainOpen: ['정책 설명 보기', 'ポリシーの説明を見る'],
  policyDecision: ['정책 결정', 'ポリシー判定'],
  piiTitle: ['개인정보 후보', '個人情報の候補'],
  piiNone: ['개인정보로 보이는 데이터는 없었어요.', '個人情報らしきデータはありませんでした。'],
  piiReview: ['사람 확인 필요', '要確認'],
  piiConfident: ['개인정보로 판단', '個人情報と判定'],
  stubPolicy: ['이 실행은 정책 엔진 대신 간단한 stub을 썼어요. 규칙별 이유와 설명문이 없어요.', 'この実行はポリシーエンジンの代わりに簡易スタブを使いました。ルール別の理由と説明文はありません。'],
  // 테스트 패널
  requestsMatched: ['요청의 결과가 같았어요', 'リクエストの結果が同じでした'],
  conditionNone: ['그대로 실행', 'そのまま実行'],
  conditionRestart: ['재시작 후', '再起動後'],
  conditionReplace: ['컨테이너 교체 후', 'コンテナ入れ替え後'],
  conditionLine: ['{name}: {total}개 중 {matched}개 같음', '{name}: {total}件中 {matched}件一致'],
  conditionFailLine: ['{name} 조건에서 {total}개 요청 중 {diff}개의 결과가 달랐어요', '{name}の条件で {total}件中 {diff}件の結果が違いました'],
  mismatches: ['달라진 요청', '結果が違ったリクエスト'],
  request: ['요청', 'リクエスト'],
  relatedFact: ['관련 저장 방식', '関連する保存方法'],
  unknownCause: ['원인 미상', '原因不明'],
  stubTest: ['실제 재생 테스트 대신 미리 만든 결과를 썼어요.', '実際の再生テストの代わりに用意した結果を使いました。'],
  factSqlite: ['데이터를 SQLite 파일에 저장하고 있어요', 'データを SQLite ファイルに保存しています'],
  factDb: ['데이터베이스: {db}', 'データベース: {db}'],
  factLocalFiles: ['컨테이너 안 폴더에 파일을 쓰고 있어요: {paths}', 'コンテナ内のフォルダにファイルを書いています: {paths}'],
  factMigrationDestructive: ['데이터베이스 구조를 되돌릴 수 없게 바꾸고 있어요', 'データベース構造を元に戻せない形で変更しています'],
  factMigrationSafe: ['데이터베이스 구조 변경은 안전해요', 'データベース構造の変更は安全です'],
  noTestResult: ['테스트 결과가 없어요.', 'テスト結果がありません。'],
  // 서명 패널
  signedBy: ['서명한 사람', '署名者'],
  signedAt: ['서명 시각', '署名日時'],
  signedTargets: ['서명한 배포 위치', '署名したデプロイ先'],
  signLineOk: ['정책이 허용한 내용 그대로 서명했어요.', 'ポリシーが許可した内容のまま署名しました。'],
  signLineDry: ['실제 키 대신 모의 서명을 했어요. 실제 배포에는 쓸 수 없어요.', '実際の鍵の代わりに模擬署名しました。実デプロイには使えません。'],
  signLineRefused: ['서명을 거부했어요.', '署名を拒否しました。'],
  noSign: ['서명 결과가 없어요.', '署名結果がありません。'],
  // 배포 패널
  routeTarget: ['트래픽이 가는 곳', 'トラフィックの行き先'],
  switchCount: ['전환 횟수', '切替回数'],
  standbyReady: ['대기: 장애 시 자동 전환', '待機: 障害時に自動切替'],
  standbyOff: ['대기: 자동 전환 안 함', '待機: 自動切替しない'],
  checksTitle: ['새 버전 검사', '新バージョンの検査'],
  checkPassed: ['{target}: 통과', '{target}: 合格'],
  checkFailed: ['{target}: 실패', '{target}: 失敗'],
  candidateFailed: ['{target}: 새 버전을 띄우지 못했어요', '{target}: 新バージョンを起動できませんでした'],
  deployLineActivated: ['{target}에서 새 버전이 트래픽을 받고 있어요.', '{target} で新バージョンがトラフィックを受けています。'],
  deployLineStandby: ['{target}에도 새 버전을 올려 두었어요. 장애가 나면 자동으로 넘어가요.', '{target} にも新バージョンを用意しました。障害時は自動で切り替わります。'],
  deployLineStandbyOff: ['{target}에도 새 버전을 올려 두었지만 자동 전환은 꺼져 있어요.', '{target} にも新バージョンを用意しましたが自動切替は無効です。'],
  deployLineHeld: ['새 버전이 검사를 통과하지 못해 트래픽을 옮기지 않았어요. 기존 서비스는 그대로예요.', '新バージョンが検査を通らず、トラフィックを切り替えませんでした。既存サービスはそのままです。'],
  deployLineDiscarded: ['띄웠던 새 버전은 정리했어요.', '起動した新バージョンは片付けました。'],
  deployLineRolledBack: ['전환 중에 문제가 생겨 이전 버전으로 되돌렸어요.', '切替中に問題が起きたため前のバージョンに戻しました。'],
  deployLineRouteFailRolledBack: ['새 버전은 떴지만 트래픽을 넘기지 못해 이전 버전으로 되돌렸어요. 기존 서비스는 그대로예요.', '新バージョンは起動しましたがトラフィックを渡せず、前のバージョンに戻しました。既存サービスはそのままです。'],
  deployLineRouteFailError: ['트래픽을 넘기지 못했고, 일부 대상을 이전 버전으로 되돌리지 못했어요. 직접 확인이 필요해요.', 'トラフィックを渡せず、一部の対象を前のバージョンに戻せませんでした。確認が必要です。'],
  rollbackOk: ['{target}: 이전 버전으로 되돌렸어요', '{target}: 前のバージョンに戻しました'],
  rollbackFailed: ['{target}: 되돌리지 못했어요', '{target}: 戻せませんでした'],
  deployLineSwitchFailed: ['새 버전은 떴지만 트래픽 전환이 실패했어요. 지금 트래픽은 이전 버전이 받고 있어요. 사람이 직접 전환해야 해요.', '新バージョンは起動しましたがトラフィック切替に失敗しました。今は前のバージョンが受けています。手動での切替が必要です。'],
  deployLineError: ['배포 중 오류가 나서 멈췄어요.', 'デプロイ中にエラーが起きて止まりました。'],
  deployLineErrorCloud: ['Cloud Run에는 새 버전이 올라가 있을 수 있어요. 직접 확인이 필요해요.', 'Cloud Run には新バージョンが残っている可能性があります。確認が必要です。'],
  deployLineSkipped: ['이 실행에서는 배포 단계를 건너뛰었어요. 실제 배포는 없었어요.', 'この実行ではデプロイ段階をスキップしました。実デプロイはありません。'],
  deployLineGate: ['배포 조건이 맞지 않아 시작하지 않았어요: {reason}', 'デプロイ条件を満たさず開始しませんでした: {reason}'],
  deployLineNotRun: ['배포는 진행하지 않았어요.', 'デプロイは実行していません。'],
  // 증명 체인
  proofChain: ['증명 체인', '証明チェーン'],
  proofRun: ['같은 배포 요청', '同じデプロイ依頼'],
  proofSource: ['같은 코드', '同じコード'],
  proofDigest: ['같은 이미지', '同じイメージ'],
  proofPlan: ['같은 결정', '同じ判定'],
  proofOk: ['확인', '確認'],
  proofMismatch: ['불일치', '不一致'],
  proofPending: ['확인 전', '未確認'],
  proofNa: ['해당 없음', '対象外'],
  proofUnverified: ['미확인', '未確認'],
  // 하단 세부 기술 정보
  identifiers: ['실행 식별자', '実行の識別子'],
  runId: ['실행 ID', '実行 ID'],
  commit: ['소스 커밋', 'ソースコミット'],
  digest: ['이미지 digest', 'イメージ digest'],
  trigger: ['시작 방식', '開始方法'],
  webhook: ['GitHub push', 'GitHub push'],
  manual: ['수동 요청', '手動リクエスト'],
  execMode: ['실행 모드', '実行モード'],
  createdAt: ['생성', '作成'],
  updatedAt: ['갱신', '更新'],
  policyTech: ['정책 규칙 ID와 plan hash', 'ポリシールール ID と plan hash'],
  auditLog: ['감사 기록', '監査ログ'],
  artifacts: ['원본 산출물 JSON', '生の成果物 JSON'],
  time: ['시각', '日時'],
  content: ['내용', '内容'],
  rules: ['규칙', 'ルール'],
  stageSummary: ['단계 요약 원본', 'ステージ要約の生データ'],
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
  currentTraffic: ['현재 트래픽', '現在のトラフィック'],
  targetsStatus: ['대상별 상태', '対象別の状態'],
  standbyLabel: ['대기 (standby)', '待機（standby）'],
  currentTag: ['현재', '現在'],
  agentCard: ['On-Prem 에이전트', 'On-Prem エージェント'],
  healthEvery: ['{interval}초마다 확인', '{interval}秒ごとに確認'],
  lastSeen: ['마지막 응답', '最終応答'],
  serving: ['실행 중인 컨테이너', '稼働中のコンテナ'],
  trafficNow: ['지금 트래픽이 가는 곳', '現在のトラフィック先'],
  status: ['상태', '状態'],
  noRoute: ['없음', 'なし'],
  noRouteNote: ['아직 트래픽을 받는 곳이 없어요. 첫 배포가 끝나면 여기에 표시돼요.', 'まだトラフィックを受ける場所がありません。最初のデプロイが終わると表示されます。'],
  trafficOn: ['지금 트래픽은 {target}에서 처리하고 있어요', '現在のトラフィックは {target} で処理しています'],
  trafficFailedOver: ['사내 서버 장애로 Cloud Run이 대신 처리하고 있어요', '社内サーバーの障害で Cloud Run が代わりに処理しています'],
  hereNow: ['지금 여기로', '今はこちら'],
  waiting: ['대기', '待機'],
  manualAfterRecovery: ['복구되면 사람이 직접 되돌려요', '復旧後は手動で戻します'],
  notRegistered: ['아직 없음', 'まだなし'],
  notRegisteredNote: ['{target}에는 아직 배포된 버전이 없어요.', '{target} にはまだデプロイされたバージョンがありません。'],
  healthy: ['정상', '正常'],
  unhealthy: ['응답 없음', '応答なし'],
  unknown: ['확인 중', '確認中'],
  noHealth: ['상태 정보 없음', '状態情報なし'],
  networkError: ['연결이 끊김', '接続が切れています'],
  appError: ['앱이 오류 응답', 'アプリがエラー応答'],
  consecutiveOk: ['{n}번 연속 정상', '{n}回連続で正常'],
  consecutiveFail: ['{n}번 연속 실패', '{n}回連続で失敗'],
  observationExpired: ['최근 확인 없음', '最近の確認なし'],
  lastObserved: ['마지막 확인', '最終確認'],
  agent: ['사내 서버 에이전트', '社内サーバーのエージェント'],
  agentOnline: ['연결됨', '接続中'],
  agentOffline: ['연결 끊김', '切断'],
  agentOther: ['{status}', '{status}'],
  noAgents: ['연결된 사내 서버 에이전트가 없어요.', '接続中の社内サーバーエージェントはありません。'],
  deployHistory: ['배포 이력', 'デプロイ履歴'],
  servingNow: ['서비스 중', '稼働中'],
  failoverHappened: ['장애 전환이 일어났어요', '障害切替が発生しました'],
  routeChanged: ['트래픽 위치가 바뀌었어요', 'トラフィック先が変わりました'],
  bannerLine: ['{from}에서 {to}로 넘어갔어요 ({time}). {n}번째 전환', '{from} から {to} に切り替わりました（{time}）。{n}回目の切替'],
  noFailback: ['사내 서버가 복구되어도 자동으로 되돌리지 않아요. 사람이 직접 되돌려요.', '社内サーバーが復旧しても自動では戻りません。手動で戻します。'],
  changesSeen: ['이 화면에서 본 전환 기록', 'この画面で見た切替の記録'],
  healthConfig: ['{interval}초마다 상태 확인, {threshold}번 연속 실패하면 전환', '{interval}秒ごとに状態確認、{threshold}回連続失敗で切替'],
  healthOff: ['상태 확인 꺼짐', '状態確認オフ'],
  statFailoverOn: ['함', 'する'],
  statFailoverOff: ['안 함', 'しない'],
  // 앱 목록
  appsTitle: ['애플리케이션', 'アプリケーション'],
  appsSub: ['백엔드에 등록된 앱과 지금 트래픽이 가는 곳', 'バックエンドに登録されたアプリと現在のトラフィック先'],
  openApps: ['앱 목록 열기', 'アプリ一覧を開く'],
  noRouteShort: ['경로 없음', '経路なし'],
  routeUnknown: ['경로 조회 실패', '経路の取得失敗'],
  refreshing15s: ['15초마다 갱신', '15秒ごとに更新'],
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
  tokenPlaceholder: ['access_token 또는 콜백 JSON 전체 붙여넣기', 'access_token またはコールバック JSON 全体を貼り付け'],
  tokenInvalidJson: ['JSON 이 깨져 있어 저장하지 않았어요', 'JSON が壊れているため保存しませんでした'],
  tokenNoAccess: ['JSON 에 access_token 이 없어요', 'JSON に access_token がありません'],
  tokenEmpty: ['토큰이 비어 있어요', 'トークンが空です'],
  withRefresh: ['refresh 토큰 있음', 'refresh トークンあり'],
  loginHelp1: ['프론트와 백엔드 주소가 다르면, 브라우저 주소창에 백엔드 주소로 직접 {url} 을 열어 로그인을 시작하세요. 프록시(5173)로 열면 state 쿠키가 콜백까지 가지 않아요.', 'フロントとバックエンドのアドレスが違う場合は、ブラウザのアドレス欄にバックエンドのアドレスで直接 {url} を開いてログインを始めてください。プロキシ（5173）経由では state クッキーがコールバックに届きません。'],
  loginHelp2: ['응답의 authorization_url 로 이동해 GitHub 로그인을 마치면 콜백이 JSON 을 보여줘요. 그 JSON 전체(또는 access_token 만)를 아래에 붙여넣으세요. JSON 전체를 넣으면 refresh 토큰도 함께 저장돼요. 기본 만료는 15분입니다.', 'レスポンスの authorization_url へ移動して GitHub ログインを終えると、コールバックが JSON を表示します。その JSON 全体（または access_token だけ）を下に貼り付けてください。JSON 全体なら refresh トークンも一緒に保存されます。既定の期限は15分です。'],
  tokenExpired: ['토큰이 만료되었습니다. 새 토큰을 입력하세요 (refresh 토큰이 있으면 한 번 자동 갱신을 시도했어요)', 'トークンの期限が切れました。新しいトークンを入力してください（refresh トークンがあれば一度だけ自動更新を試みました）'],
  backendUnreachable: ['백엔드에 연결할 수 없습니다', 'バックエンドに接続できません'],
  requestFailed: ['요청 실패', 'リクエスト失敗'],
  error: ['오류', 'エラー'],
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
  if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
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

/** 해결 조건 id 를 사람이 읽는 할 일 / 이유로 바꾼다. 모르는 id 는 undefined (정책의 hint 를 그대로 쓴다). */
export function requireCopy(lang: Lang, id: string): { title: string; why: string } | undefined {
  const ja = lang === 'ja';
  const table: Record<string, [string, string, string, string]> = {
    fix_restart_failure: ['재시작해도 데이터가 남게 고치기', '앱이 시작할 때 데이터를 지우거나 메모리에만 두고 있어요.', '再起動してもデータが残るように直す', 'アプリ起動時にデータを消すか、メモリにだけ置いています。'],
    fix_tests: ['기대한 응답이 나오도록 고치기', '그대로 실행해도 요청 결과가 기록과 달랐어요.', '期待どおりの応答になるよう直す', 'そのまま実行してもリクエスト結果が記録と違いました。'],
    investigate_replace_failure: ['컨테이너 교체 후 달라진 응답의 원인 찾기', '교체 뒤에만 결과가 달라졌는데 저장 방식으로 설명되지 않아요.', 'コンテナ入れ替え後に変わった応答の原因を調べる', '入れ替え後だけ結果が変わり、保存方法では説明できません。'],
    managed_db: ['SQLite를 관리형 DB로 옮기기', '컨테이너가 바뀌면 SQLite 파일이 함께 사라져요.', 'SQLite をマネージド DB に移す', 'コンテナが変わると SQLite ファイルも消えます。'],
    object_storage: ['업로드 파일을 외부 저장소로 옮기기', '컨테이너 안 폴더에 둔 파일은 교체할 때 사라져요.', 'アップロードファイルを外部ストレージに移す', 'コンテナ内のフォルダに置いたファイルは入れ替え時に消えます。'],
    rerun_same_run: ['같은 실행으로 테스트와 개인정보 판정 다시 하기', '테스트와 개인정보 판정이 서로 다른 실행에서 나왔어요.', '同じ実行でテストと個人情報判定をやり直す', 'テストと個人情報判定が別の実行から出ています。'],
    human_review_pii: ['개인정보인지 사람이 확인하기', '개인정보로 보이지만 확신할 수 없는 데이터가 있어요.', '個人情報かどうか人が確認する', '個人情報らしいが確信できないデータがあります。'],
    two_phase_migration: ['데이터베이스 변경을 두 단계로 나누기', '되돌릴 수 없는 구조 변경이 들어 있어요. 먼저 추가하고 다음 배포에서 정리해요.', 'データベース変更を2段階に分ける', '元に戻せない構造変更が含まれています。先に追加し、次のデプロイで整理します。'],
    approval: ['사람의 승인 받기', '이 배포는 사람이 확인해야 진행할 수 있어요.', '人の承認を受ける', 'このデプロイは人が確認しないと進められません。'],
    resolve_target_conflict: ['배포 위치 충돌 풀기', '규칙들이 허용하는 위치가 서로 겹치지 않아요.', 'デプロイ先の衝突を解消する', 'ルール同士が許可する場所が重なりません。'],
  };
  const row = table[id];
  if (!row) return undefined;
  return ja ? { title: row[2], why: row[3] } : { title: row[0], why: row[1] };
}
