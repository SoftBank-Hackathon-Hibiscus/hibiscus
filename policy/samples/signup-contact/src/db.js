import Database from "better-sqlite3";

// 데모용 로컬 파일 DB
export const db = new Database("/app/data.db");
