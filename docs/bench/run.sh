#!/usr/bin/env bash
# Прогон одной ячейки бенчмарка: свежий worktree на BASE, один делегат, метрика в csv.
#
# Джоб опознаётся по run_root, а не по разбору вывода запуска: worktree назван
# ключом ячейки, и это единственная связь, которую нельзя потерять на парсинге —
# потерянный id раньше стоил снесённого дерева под работающим агентом.
set -u
S="$(dirname "$(readlink -f "$0")")"
COMP=/home/sli/github/pi-plugin-cc/plugins/pi/scripts/pi-companion.mjs
REPO=/home/sli/sandbox/udmp/UDMP-3766/data-marketplace
BASE=0439916
DB=/home/sli/.local/share/pi-plugin/jobs.db
CSV="$S/results.csv"
[ -f "$CSV" ] || echo "key,rep,job,phase,status,turns,output_tokens,duration_s,truncs,max_out,repeat_run" > "$CSV"

key="$1"; model="$2"; sandbox="$3"; rep="$4"; prompt_file="${5:-$S/fixture-a.md}"
wt="$S/wt-$key-$rep"
git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$wt"
git -C "$REPO" worktree add --detach "$wt" "$BASE" >/dev/null 2>&1 || { echo "worktree fail $key-$rep"; exit 1; }

PI_TRUNCATION_RETRIES=0 timeout 2400 node "$COMP" delegate \
  --preset go-developer --model "$model" --sandbox "$sandbox" \
  --cwd "$wt" --timeout 1800 --json --stdin < "$prompt_file" >/dev/null 2>&1

# Ждём завершения по состоянию джоба, найденного по его рабочему каталогу.
for _ in $(seq 1 300); do
  done_now=$(python3 -c "
import sqlite3,sys
c=sqlite3.connect('$DB')
r=c.execute(\"select phase,status from jobs where run_root=? order by created_at desc limit 1\",('$wt',)).fetchone()
print(1 if r and r[1] not in ('running','starting',None) else 0)" 2>/dev/null || echo 0)
  [ "$done_now" = "1" ] && break
  sleep 10
done

python3 - "$key" "$rep" "$wt" "$CSV" "$DB" <<'PY'
import sys,sqlite3
key,rep,wt,csv,db=sys.argv[1:6]
c=sqlite3.connect(db)
r=c.execute("select id,phase,status,turns,output,duration_seconds from jobs where run_root=? order by created_at desc limit 1",(wt,)).fetchone()
if not r:
    open(csv,'a').write(f"{key},{rep},,NO_JOB,,,,,,,\n"); print(f"[{key} #{rep}] джоб не найден"); raise SystemExit
job=r[0]
tr=c.execute("select count(*) from requests where job_id=? and lower(finish_reason) in ('length','max_tokens')",(job,)).fetchone()[0]
mx=c.execute("select max(out_tokens) from requests where job_id=?",(job,)).fetchone()[0] or 0
rows=[x[0] for x in c.execute("select out_tokens from requests where job_id=? order by seq",(job,))]
best=run=0; last=None
for out in rows:
    if out and out>=200:
        same = last is not None and abs(out-last)<=max(1,out*0.01)
        run = run+1 if same else 1; best=max(best,run); last=out
    elif out is not None:
        run=0; last=None
open(csv,'a').write(f"{key},{rep},{job},{r[1]},{r[2]},{r[3]},{r[4]},{r[5]},{tr},{mx},{best}\n")
print(f"[{key} #{rep}] phase={r[1]} turns={r[3]} обрывов={tr} max_out={mx} повтор={best}")
PY
git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1
