# Конфигурация: слои, пресеты, проектные надстройки

Правила слияния слоёв, что проекту разрешено переопределять и как подкрутить глобальный
пресет под один репозиторий. В скилле остаётся только то, что нужно на запуске.

Необязательна. `~/.claude/pi/config.json` — личные дефолты, `<repo>/.claude/pi/config.json` — проектные (перебивают личные, флаги перебивают оба).

```json
{
  "defaults": { "model": "openrouter/deepseek/deepseek-v4-flash-0731", "thinking": "high" },
  "presets": {
    "fast":  { "description": "быстрые узкие вопросы без размышления", "model": "opencode-go/deepseek-v4-flash", "thinking": "off" },
    "audit": { "description": "враждебный разбор готовой работы, ничего не правит", "model": "opencode-go/kimi-k3", "systemPrompt": "adversarial", "readOnly": true },
    "dba":   {
      "model": "opencode-go/kimi-k3",
      "systemPrompt": "@.claude/pi/prompts/dba.md",
      "appendSystemPrompt": ["Отвечай по-русски."],
      "tools": "read,grep,find,ls,bash"
    }
  },
  "commands": { "review": { "preset": "audit" } }
}
```

**Пресет — это целый агент, а не только модель.** Дай ему `description` — одну строку о том, для чего он: её печатает `/pi:models` в списке пресетов, и по ней выбирают агента, не открывая системный промпт (чтение промпта ради выбора стоит дороже самого выбора). Кроме описания в пресете можно задать любое поле запуска: `model`, `provider`, `thinking`, `systemPrompt`, `appendSystemPrompt`, `tools`, `excludeTools`, `extensions`, `skills`, `sandbox`, `mounts`, `readOnly`, `noTools`, `noBuiltinTools`, `noExtensions`, `noSkills`, `timeoutMs`, `engine`. Задал один раз — дальше запускаешь `--preset dba`.

Один дефолт задан за тебя: `excludeTools: ["ask_question"]` — прогон неинтерактивный, спрашивать некого, и вопрос агента просто сожжёт ход. Вернуть инструмент: `"excludeTools": []` в любом слое.

Значения разрешаются послойно, сверху вниз: флаги → пресет → дефолты команды → общие дефолты. Исключение — commit-identity: там между флагами и пресетом вклинивается твой gitconfig (см. «От чьего лица коммитит агент»). Системный промт выбирается целиком, поэтому `--system-prompt` в командной строке полностью заменяет пресетный. Списки `appendSystemPrompt`, `extensions`, `skills` и `mounts` со всех слоёв складываются.

### Подкрутить глобальный пресет под проект

Проектный конфиг **сливается** с пользовательским по полям, поэтому в репозитории пишется только отличие:

```json
{
  "presets": {
    "go-review": {
      "model": "opencode-go/kimi-k3",
      "appendSystemPrompt": ["Сервис на sqlc: миграции генерируются, руками не править."]
    }
  },
  "sandboxProfiles": { "go": { "mounts": ["~/proj/protos:/protos:ro"] } }
}
```

Промт, `readOnly`, песочница и весь Go-тулчейн достаются из глобальных определений нетронутыми. Правила слияния:

- **Оснастка складывается** — `appendSystemPrompt`, `extensions`, `skills`, `mounts`, `env`, `args`. Совпавшая запись занимает место унаследованной: mounts сопоставляются по контейнерному пути, env — по имени переменной.
- **Решения заменяются** — `model`, `thinking`, `systemPrompt`, `sandbox`, `readOnly`, `tools`, `excludeTools`, `timeoutMs`.
- **`null` удаляет** — `"sandbox": null` снимает песочницу, заданную глобально. Единственный выход из слияния.

Вложенные объекты сливаются так же: `"sandbox": {"network": "none"}` сохраняет image, mounts и остальное из нижнего слоя.

**Системный промт под проект** — три способа, от разового к постоянному: `--system-prompt @./.claude/pi/prompts/try-a.md` на один прогон; файл `<проект>/.claude/pi/prompts/<имя>.md` затеняет одноимённый глобальный для всех пресетов; `<проект>/.claude/pi/APPEND_SYSTEM.md` дописывается к любому промту всегда.

Если что-то не работает — начни с `setup`: он покажет, найден ли бинарь pi, есть ли доступные модели, какие конфиги подхвачены и где лежит состояние задач.
