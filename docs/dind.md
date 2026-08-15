# go-dind: контейнеры внутри песочницы

Профиль `go-dind` даёт агенту собственный docker внутри песочницы — для тестов на
`testcontainers-go` и E2E против compose-стека репозитория. Здесь то, как он устроен и что
нужно один раз настроить на хосте; рабочая команда — в скилле (`skills/pi/SKILL.md`).

Тесты на `testcontainers-go` поднимают БД контейнером — в обычном профиле такого нет и быть не должно. Профиль `go-dind` даёт прогону **свой** rootless-демон: его контейнеры живут внутри песочницы, умирают вместе с ней и в `docker ps` на хосте не видны.

```bash
delegate --sandbox go-dind "почини интеграционные тесты advertising-api"
sandbox build go-dind      # образ собирается отдельно от go
```

Ни хостового сокета, ни `--privileged`. Всё, что понадобилось (замерено, не взято из инструкции):

| Что | Зачем |
|---|---|
| `--security-opt seccomp=@sandbox/dind-seccomp.json` | дефолтный профиль docker блокирует `unshare`/`mount`/`clone` с `CLONE_NEW*` — без них rootless не стартует. `@sandbox/` резолвится по тем же каталогам, что и Dockerfile (проект → `~/.claude/pi/sandbox` → плагин), чтобы не хардкодить абсолютный путь |
| `--device /dev/net/tun` | RootlessKit создаёт tap-интерфейс; без него падает на `ip tuntap add` |
| `DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=--pidns` | со своим PID namespace демон получает собственный `/proc` и может писать sysctl в свои сетевые namespace |
| volume `pi-dind-images` под `~/.local/share/docker` | иначе образы качаются заново каждый прогон |
| `TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1` | иначе testcontainers адресует контейнеры через `172.17.0.1` и виснет на проверке готовности |
| `TESTCONTAINERS_RYUK_DISABLED=true` | уборщик не нужен: всё внутри умирает вместе с песочницей |

`docker compose` в образе есть (plugin) — для E2E против compose-стека репозитория, не только testcontainers. `DOCKER_HOST`/`XDG_RUNTIME_DIR` не задаются в env профиля: entrypoint выводит их из `id -u`, чтобы образ работал под любым uid.

**Не понадобились:** `apparmor=unconfined` (на Docker Desktop AppArmor не активен; на нативном Linux с активным AppArmor профиль `docker-default` доложит часть mount-операций поверх seccomp — там, скорее всего, понадобится), `systempaths=unconfined` (`/proc/kcore` и `/proc/sysrq-trigger` остаются замаскированными), `--device /dev/fuse` (overlay2 работает поверх volume нативно), `--privileged`.

**Профиль seccomp** генерируется из профиля rootless podman (`containers/common`) скриптом `make-dind-seccomp.py` рядом с Dockerfile — там же зафиксированы URL upstream, дата, sha256 исходника и результата, и команда воспроизведения (`--fetch` скачивает и сверяет хэш). Он разрешает четыре сисколла, которые upstream держит за `CAP_SYS_ADMIN`: `sethostname`, `setdomainname`, `setns`, `chroot`. Их выполняет вложенный runc, а docker сверяет capability-гейт с правами **внешнего** контейнера, где этой capability нет. Разрешение сисколла не даёт привилегии: ядро по-прежнему требует `CAP_SYS_ADMIN` в том namespace, которым владеет вызывающий — он есть у вложенного рантайма и отсутствует у процесса, который полез бы к хосту. (Cap-гейтованный ALLOW вместо безусловного здесь **не** работает — проверено, ломает вложенный демон по той же причине: гейт резолвится по caps внешнего контейнера.)

**Версия docker в образе закреплена на 28.x** (проверка в Dockerfile валит сборку, если пришло другое). В 29.x скрипт запуска пишет `net.ipv4.ip_forward` через sysctl и падает на read-only `/proc/sys`; лечится это только `systempaths=unconfined`, то есть возвратом доступа к `/proc/kcore` ради одного sysctl.

**Переносимость.** Образ собирается под uid хоста (`RUNTIME_UID`/`RUNTIME_GID` companion передаёт из `process.getuid()`): для uid ≠ 1000 заводится пользователь и subuid-диапазон, иначе RootlessKit не стартует. При смене пользователя образ нужно пересобрать (`sandbox build go-dind`).

**Параллельные go-dind прогоны.** Хранилище образов у каждого прогона своё — монтирование помечено `:isolate`, и docker выдаёт контейнеру анонимный volume, умирающий вместе с ним. Иначе два демона дерутся за эксклюзивный lock containerd на общем volume и портят `meta.db`; общего RW-хранилища образов для нескольких dind в docker нет ([moby#40196](https://github.com/moby/moby/issues/40196)), поэтому изоляция — единственный способ поднять пул `dind` выше единицы. Кеши модулей и сборки при этом остаются общими: `:isolate` действует на одно монтирование, в отличие от `isolateCaches`, который анонимизирует все.

Цена изоляции — холодное хранилище образов на каждом старте, и её снимает **зеркало-кеш на хосте**:

```bash
docker run -d --restart=always --name pi-registry-mirror -p 5000:5000 \
  -v pi-registry-cache:/var/lib/registry \
  -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io registry:2
```

Профиль передаёт демону внутри песочницы `PI_REGISTRY_MIRROR` (по умолчанию `http://host.docker.internal:5000`), entrypoint пишет из него `registry-mirrors` + `insecure-registries` + `max-concurrent-downloads: 10` в `daemon.json` до старта dockerd. Первый прогон греет зеркало, остальные тянут слои по локальной сети. Зеркало недоступно — docker сам идёт в апстрим, прогон не ломается. Проксируется только Docker Hub: приватные реестры ходят напрямую.

**Остаточный риск.** Проверено pen-test-агентом изнутри: побег на хост **не достигнут**. seccomp реально отдаёт EPERM на `fsopen`/`open_by_handle_at`/`bpf`/`userfaultfd`/`kexec` даже с полными caps в user namespace — это и есть примитивы userns-escape. Агент может создавать user namespace и монтировать внутри него, но `mount_setattr` на host-маунтах даёт EPERM (их владелец — init userns), а побег остаётся только через уязвимость ядра, не через штатный механизм. Хостового демона, устройств хоста, немаскированного `/proc` и `CAP_SYS_ADMIN` снаружи у него нет. Прогон, ослабляющий изоляцию, сам об этом сообщает: `Sandbox replaces the default seccomp profile…`, `Sandbox passes the host device /dev/net/tun…`.
