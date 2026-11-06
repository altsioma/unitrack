# Типовые задачи unitrack — сценарии для AI-агента

Три сценария показывают, как применять правила на реальных сущностях проекта.
Правила здесь не повторяются: архитектура — [`ARCHITECTURE.md`](ARCHITECTURE.md),
работа с кодом — [`DEVELOPMENT.md`](DEVELOPMENT.md), формат ответа — [`CLAUDE.md`](../../CLAUDE.md).

---

## Сценарий 1. Новый source provider

### Цель
Добавить `SourceProvider` для нового типа хранилища так, чтобы его можно было подключить
в хост без изменений `@unitrack/core`. Пример — WebDAV-сервер с HTTP Basic-аутентификацией.

### Что должен сделать агент
1. **Изучить аналоги.** `packages/plugins/any/source-s3` и `source-subsonic` — сетевые провайдеры
   с конфигурацией фабрики и `requiresRevalidation: true`; `source-direct-url` — минимальный
   `HEAD`-провайдер. Контракт — `SourceProvider`, `SourceRef`, `SourceToken`, `ResolvedSource`
   в `packages/core/src/types.js`; проверки при регистрации — `PluginRegistry.registerSourceProvider()`;
   поведенческие — `assertSourceProviderConformance` в `@unitrack/conformance-kit`.
   Прочитать спеки этих пакетов в `docs/superpowers/specs/` (принцип «`resolve` = подтвердить
   воспроизводимость сейчас»).
2. **Проверить границы** (`ARCHITECTURE.md` §5):
   - уровень пакета: если хватает `fetch`/Web Crypto — `plugins/any`, Node API не использовать;
   - пакет не импортирует другие плагины и ядро, кроме `@unitrack/core/types`;
   - учётные данные: Basic-auth передаётся заголовком — значит через `ResolvedSource.headers`,
     а не в URL; заголовки и `token.token` не попадают в сообщения ошибок и логи;
   - как web-движки воспроизведут источник с `headers` — через `acquireWebMediaUrl`
     (`@unitrack/media-delivery-web`), с его ограничениями (Blob, CORS) — `ARCHITECTURE.md` §7.
3. **Неоднозначности — до кода.** Что именно является `SourceToken.token` (путь на сервере? полный URL?),
   какой `kind`, нужен ли `HEAD` в `resolve()`, какой `mime` при отсутствии `Content-Type`
   (`ARCHITECTURE.md` §7 про `''`). Если задача не отвечает — вынести в вопрос в формате
   `DEVELOPMENT.md` §8, предложив вариант по аналогии с существующими провайдерами.
4. **План** (затрагивает новый пакет, lock-файл, README, возможно хост) — показать до реализации,
   как в `DEVELOPMENT.md` §1. Нужна ли design-спека — спросить (`DEVELOPMENT.md` §7).
5. **Реализация** по `DEVELOPMENT.md` §3 («Любой новый workspace-пакет», «Новый plugin»,
   «Новый source provider»). Подключение к хосту — только если это входит в задачу.

### Prompt
```
Добавь новый SourceProvider для WebDAV-сервера с HTTP Basic-аутентификацией
(логин/пароль задаются при создании провайдера). Он должен работать и в браузере,
и в Electron, без Node API. В хосты пока не подключай.

Перед реализацией изучи существующие source-провайдеры и контракт SourceProvider,
затем покажи план: расположение пакета, что будет SourceToken.token, kind,
capabilities, как передаются учётные данные, какие тесты будут добавлены.
Открытые вопросы перечисли отдельно. Код не пиши, пока я не подтвержу план.
```

### Ожидаемый результат
Первый ответ — план и вопросы, без кода. После подтверждения — отчёт по формату `CLAUDE.md`:
```
Summary:                добавлен @unitrack/source-webdav (plugins/any), не подключён к хостам
Changes:                packages/plugins/any/source-webdav/{package.json,tsconfig*.json,src/index.js,
                        test/index.test.js,test/conformance.test.js,test/helpers/testServer.js};
                        package-lock.json; README.md (таблица Packages)
Verification:           npm test — pass; npm run build:types — pass; npm run typecheck — pass
Risks / Open Questions: воспроизведение с headers идёт через fetch→Blob (CORS, память);
                        в реальном хосте не проверялось
```

### Критерии готовности
- Пакет на уровне, соответствующем используемым API; workspace-глоб его подхватывает.
- `PluginRegistry` принимает провайдер; `assertSourceProviderConformance` проходит.
- Учётные данные только в `headers`; ни токен, ни заголовки не встречаются в ошибках
  (это проверено тестом).
- `@unitrack/core`, другие плагины и хосты не изменены (если подключение не входило в задачу).
- `package-lock.json` и таблица пакетов в README обновлены.

### Проверки
- `npm test -w @unitrack/source-webdav` в процессе; перед отчётом — `npm test`,
  `npm run build:types`, `npm run typecheck` (`DEVELOPMENT.md` §6).
- Тесты: поведенческие против локального `test/helpers/testServer.js` (успех, 401/403, 404,
  таймаут, `revalidate`), conformance-тест.

---

## Сценарий 2. Изменение существующего поведения

### Цель
Изменить поведение одной публичной команды, не затрагивая остальное. Пример —
`CorePlayer.prev()`: сейчас всегда переходит к предыдущему элементу очереди (на первом —
ничего не делает); требуется, чтобы при позиции дальше порога текущий трек начинался сначала.

### Что должен сделать агент
1. **Зафиксировать текущее поведение по коду и тестам**, а не по памяти:
   `CorePlayer.prev()` → `#prev()` → `QueueManager.movePrevious()` (включая ветку shuffle-истории)
   → `#loadAndPlayCurrent()`; откуда берётся позиция (`#position`, обновляется событием
   движка `progress`); как ведёт себя `#seek()` в разных `status`. Существующие тесты —
   `packages/core/test/CorePlayer.test.js` («prev loads and plays the preceding queue item» и др.),
   `Queue.test.js`.
2. **Найти потребителей:** вызовы `core.prev()` в `apps/electron-demo/preload.mjs` и
   `apps/web-demo`; поведение с движком `lookaheadPlayback` (`engine-audio-queue`), где переход
   идёт через план и ревизии.
3. **Минимальный scope.** Меняется `#prev()` (и, если нужно, только он); `QueueManager` не
   трогается, если задача решается без него; соседние методы не «улучшаются»
   (`DEVELOPMENT.md` §2).
4. **Неоднозначности — спросить, а не выбрать:** значение порога и где оно задаётся
   (константа или настройка), что делать в статусе `paused`, в `idle`, на первом элементе,
   при repeat `'one'`. Пункты, не определённые задачей, — в вопрос по `DEVELOPMENT.md` §8.
5. **Регрессионные тесты:** новый сценарий + сохранение старого (позиция до порога → переход
   назад), на `mockPlugins.js`; существующие тесты не удалять ради прохождения.
6. Сообщить, нужен ли комментарий/JSDoc у `prev()` и затронута ли документация
   (`DEVELOPMENT.md` §7) — без правок не связанных документов.

### Prompt
```
Измени поведение CorePlayer.prev(): если текущий трек проигран дальше 3 секунд,
prev() должен перезапускать его с начала; иначе — прежнее поведение.

Сначала опиши текущую реализацию prev() и всех её потребителей (хосты, движки,
тесты), затем — минимальный набор изменений и случаи, которые требование не
покрывает (paused, idle, первый элемент, shuffle, lookahead-движок). По неясным
случаям задай вопросы до изменения кода. Не рефактори соседние методы.
```

### Ожидаемый результат
Первый ответ — описание текущего поведения, scope и вопросы. После ответов — отчёт:
```
Summary:                prev() перезапускает текущий трек при позиции > 3 с
Changes:                packages/core/src/CorePlayer.js (#prev, JSDoc);
                        packages/core/test/CorePlayer.test.js (+N тестов)
Verification:           npm test — pass; build:types — pass; typecheck — pass
Risks / Open Questions: позиция берётся из последнего 'progress' движка (троттлинг);
                        ручная проверка в Electron не выполнялась
```

### Критерии готовности
- Новое поведение и сохранённое старое покрыты тестами в `packages/core/test/`.
- Команда по-прежнему выполняется через `#enqueue` (`ARCHITECTURE.md` §5).
- Диф ограничен `#prev()` и тестами (+ JSDoc); публичная сигнатура `prev()` не изменена.
- Все неясные случаи либо согласованы, либо явно перечислены в Risks / Open Questions.

### Проверки
- `npm test -w @unitrack/core` в процессе; перед отчётом — полный набор `DEVELOPMENT.md` §6
  (core используется всеми пакетами и хостами).
- Ручная проверка кнопки Prev в хостах — по возможности; иначе указать, что не выполнялась.

---

## Сценарий 3. Изменение публичного контракта

### Цель
Расширить плагинный контракт, не сломав его потребителей незаметно. Пример — дать ядру знать,
сколько живёт `ResolvedSource`: `source-s3` выдаёт presigned URL на `expiresInSeconds`
(по умолчанию 300 с), а `CorePlayer` разрешает до `DEFAULT_LOOKAHEAD_WINDOW` элементов вперёд
для `setPlaybackPlan()` — заранее полученный URL может истечь до начала воспроизведения.

### Что должен сделать агент
1. **Определить текущий контракт:** `ResolvedSource` и `PlaybackPlan` в `types.js`,
   `CONTRACT_VERSION`, `assertResolvedSourceShape` в `conformance-kit`, построение плана в
   `CorePlayer.#resolveLookaheadPlan()` / `#refreshLookaheadPlan()`, обработка плана в
   `engine-audio-queue` (`setPlaybackPlan`).
2. **Найти всех потребителей и производителей** `ResolvedSource`: все `src/index.js` провайдеров,
   оба web-движка, `media-delivery-web`, `conformance-kit`, моки `packages/core/test/helpers/mockPlugins.js`,
   `ts-consumer-fixture`, хосты.
3. **Связанные спеки и документы:** `2026-08-19-playback-coordination-delivery-contract-v0.4-design.md`
   (план, ревизии, «disposable state»), `2026-08-20-source-s3-design.md`,
   `2026-08-18-cross-platform-foundation-v0.3-design.md` (решение о точном совпадении
   `contractVersion`), `CONTEXT.md` (термин `ResolvedSource`).
4. **Impact analysis** — какие пакеты меняются обязательно, какие опционально; меняется ли
   поведение ядра или только форма данных.
5. **Определить breaking/non-breaking явно.** Здесь это не очевидно: опциональное поле не ломает
   форму типа, но `PluginRegistry` требует точного `contractVersion === CONTRACT_VERSION`, а
   правило «когда повышать `CONTRACT_VERSION` и версии пакетов» в проекте не определено
   (`DEVELOPMENT.md` §8, список расхождений). **Остановиться и запросить решение** по версии
   контракта, версиям пакетов и необходимости design-спеки — не угадывать.
6. Определить, что обновляется вместе с контрактом (`ARCHITECTURE.md` §6, строка «Изменение контракта»;
   `DEVELOPMENT.md` §5, §7): JSDoc `types.js`, conformance-kit, моки,
   тесты, `ts-consumer-fixture`, README/`CONTEXT.md` при новом термине.
7. Реализацию начинать только после решения по п. 5 и подтверждённого плана.

### Prompt
```
Presigned URL от source-s3 могут истечь до того, как engine-audio-queue начнёт
играть заранее подготовленную запись PlaybackPlan. Нужно, чтобы контракт позволял
учитывать срок жизни ResolvedSource.

Это изменение публичного контракта. Код пока не меняй. Подготовь:
1) текущий контракт и всех производителей/потребителей ResolvedSource;
2) связанные спецификации;
3) варианты изменения контракта с оценкой breaking/non-breaking;
4) impact analysis по пакетам: код, тесты, conformance-kit, ts-consumer-fixture,
   документация, CONTRACT_VERSION и версии пакетов;
5) вопросы, которые нужно решить мне, прежде чем начинать.
```

### Ожидаемый результат
Ответ — анализ без изменений в файлах, с решениями, вынесенными на пользователя:
```
Summary:                анализ изменения ResolvedSource; код не менялся
Changes:                нет
Verification:           не применимо (только чтение кода и спек)
Risks / Open Questions:
  Обнаружено: правило повышения CONTRACT_VERSION для аддитивных изменений не определено
  Варианты:   A) опциональное поле + bump CONTRACT_VERSION  B) … C) …
  Предлагаю:  …
  Почему:     …
  + нужна ли design-спека; меняются ли версии пакетов
```
После решений — реализация и отчёт со списком всех затронутых пакетов.

### Критерии готовности
- До реализации: перечислены все производители/потребители, характер изменения назван явно,
  решения по версии контракта и спеке приняты пользователем.
- После реализации: JSDoc `types.js`, `PluginRegistry`/conformance-kit (если меняются правила),
  моки, тесты и `ts-consumer-fixture` согласованы с новым контрактом; все first-party плагины
  проходят регистрацию и conformance.
- Существующие спеки не переписаны (новое решение — новой спекой, если согласовано).
- Обнаруженные несвязанные расхождения перечислены, но не исправлены.

### Проверки
- Полный набор `DEVELOPMENT.md` §6: `npm test` → `npm run build:types` → `npm run typecheck`
  (включает typecheck `ts-consumer-fixture` против сгенерированных `.d.ts`).
- Тесты: регистрация с новым/старым `contractVersion`, conformance-kit на корректных и сломанных
  моках, поведение ядра с полем и без него.
- Ручной прогон `web-demo` с S3 — по возможности; иначе указать в Risks.
