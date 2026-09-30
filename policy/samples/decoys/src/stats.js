import { db } from "./db.js";

// 문의 페이지 방문 횟수 (개인정보 아님: 정수 카운터)
export function recordContactPageView() {
  db.prepare("UPDATE stats SET contact_count = contact_count + 1 WHERE id = 1").run();
}

// 티켓 번호: 숫자 문자열이지만 전화번호가 아니다
export function issueTicket() {
  const ticket_no = String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
  db.prepare("INSERT INTO stats (ticket_no) VALUES (?)").run(ticket_no);
  return ticket_no;
}
