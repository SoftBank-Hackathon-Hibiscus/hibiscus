// 로그인·로그아웃 뒤 어디로 가는지. 둘 다 홈(#/)이다.
// 홈은 데이터를 보여주지 않으므로 로그아웃 직후 이전 화면의 데이터가 남아 보이지 않는다.
import { writeToken } from '../api/token';
import { HOME_PATH, navigate as defaultNavigate } from './router';

export const AFTER_SIGN_IN_PATH = HOME_PATH;
export const AFTER_SIGN_OUT_PATH = HOME_PATH;

/** 토큰 저장과 /users/me 확인이 끝난 뒤 호출한다. */
export function finishSignIn(navigate: (path: string) => void = defaultNavigate): void {
  navigate(AFTER_SIGN_IN_PATH);
}

/** 이 브라우저의 access/refresh 토큰만 지우고 홈으로 간다. backend 세션이나 GitHub 로그인은 건드리지 않는다. */
export function signOut(navigate: (path: string) => void = defaultNavigate): void {
  writeToken(null);
  navigate(AFTER_SIGN_OUT_PATH);
}
