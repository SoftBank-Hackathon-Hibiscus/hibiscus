import { httpApi, type Api } from "./client";
import { isMockMode } from "./session";
import { mockApi } from "../mocks/mockApi";

// 모드는 페이지를 불러올 때 한 번 결정. 바꾸면 새로고침
export const MOCK = isMockMode();
export const api: Api = MOCK ? mockApi : httpApi;
