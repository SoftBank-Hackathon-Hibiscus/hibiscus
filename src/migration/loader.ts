/**
 * 마이그레이션 파일 찾기 (유일하게 fs 를 쓰는 부분)
 *
 *   migrations/**\/*.sql                   → 이름 = migrations/ 기준 상대 경로에서 .sql 을 뺀 것
 *   prisma/migrations/<이름>/migration.sql  → 이름 = 폴더 이름
 *
 * --since <이름> 이 있으면 그 이름보다 뒤(문자열 순)인 파일만 남긴다.
 * 마이그레이션 이름은 보통 번호나 타임스탬프로 시작하므로 문자열 순서가 적용 순서다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { MigrationFile } from "./analyzer.js";

const posix = (p: string) => p.split("\\").join("/");

function walkSql(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkSql(full));
    else if (name.toLowerCase().endsWith(".sql")) out.push(full);
  }
  return out;
}

export function loadMigrationFiles(appDir: string): MigrationFile[] {
  const files: MigrationFile[] = [];

  const plain = join(appDir, "migrations");
  if (existsSync(plain) && statSync(plain).isDirectory()) {
    for (const full of walkSql(plain)) {
      const rel = posix(relative(plain, full));
      files.push({ name: rel.replace(/\.sql$/i, ""), path: posix(relative(appDir, full)), content: readFileSync(full, "utf8") });
    }
  }

  const prisma = join(appDir, "prisma", "migrations");
  if (existsSync(prisma) && statSync(prisma).isDirectory()) {
    for (const name of readdirSync(prisma)) {
      const full = join(prisma, name, "migration.sql");
      if (statSync(join(prisma, name)).isDirectory() && existsSync(full)) {
        files.push({ name, path: posix(relative(appDir, full)), content: readFileSync(full, "utf8") });
      }
    }
  }

  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface SinceResult {
  files: MigrationFile[];
  /** since 로 준 이름이 실제 파일 목록에 있었는지 (없으면 오타일 수 있어 CLI 가 알린다) */
  sinceFound: boolean;
}

export function filterSince(files: MigrationFile[], since: string | undefined): SinceResult {
  if (since === undefined) return { files, sinceFound: true };
  return { files: files.filter((f) => f.name > since), sinceFound: files.some((f) => f.name === since) };
}
