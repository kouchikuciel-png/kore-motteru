#!/usr/bin/env bash
# ローカル専用: 使い捨てPostgreSQLに supabase/*.sql を順に適用し、DBテストを実行する。
# 本番Supabaseには一切接続しない。PostgreSQL 14+ の initdb / pg_ctl が必要。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGTEST_PORT:-54329}"
WORK="$(mktemp -d)"
RUN_AS=()

if [ "$(id -u)" = "0" ]; then
  # initdb は root で実行できないため postgres ユーザーで動かす。
  chown postgres "$WORK"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() {
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

export PGTEST_DATABASE_URL="postgresql://postgres@/postgres?host=$WORK&port=$PORT"

# Supabase相当の前提（anon / authenticated ロール、extensions スキーマの pgcrypto）。
psql "$PGTEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 <<'SQL'
create role anon nologin;
create role authenticated nologin;
create schema extensions;
create extension pgcrypto schema extensions;
alter database postgres set search_path = public, extensions;
SQL

for file in "$ROOT"/supabase/[0-9][0-9][0-9]_*.sql; do
  name="$(basename "$file")"
  case "$name" in
    *_test_*) continue ;; # 本番確認用の手動テストSQLは除外
  esac
  # migration 適用前の既存データを再現するフィクスチャ（例: before_018_*.sql）。
  for fixture in "$ROOT"/tests/db/fixtures/before_"${name%%_*}"_*.sql; do
    [ -e "$fixture" ] || continue
    psql "$PGTEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$fixture" >/dev/null
  done
  psql "$PGTEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$file" >/dev/null
  if [ "$name" = "001_create_schema.sql" ]; then
    # テスト用の家庭（003/005/010 の初期トークン発行が参照する）。
    psql "$PGTEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "insert into public.households (display_name) values ('新井家・試験')" >/dev/null
  fi
done

echo "applied migrations to disposable database"
node --test "$ROOT"/tests/db/*.test.js
