# Архитектура unitrack — справочник для AI-агента

Документ описывает **текущее** состояние кода. Источник истины по причинам решений —
`docs/superpowers/specs/*-design.md`; глоссарий — `CONTEXT.md`; обзор и команды — `README.md`.
Если код и спецификация расходятся, это баг в одном из них — не исправлять молча.

## 1. Назначение

unitrack — headless-ядро музыкального плеера на плагинах, независимое от UI, бэкенда и платформы.

- **Проблема:** один и тот же трек может существовать в нескольких физических воплощениях
  (локальный FLAC, Subsonic-сервер, S3-бакет, прямой URL). Ядро хранит трек как логическую
  сущность (`LogicalTrack`) со списком источников и само выбирает, какой из них проиграть,
  по настраиваемой политике с fallback.
- **Основные сценарии:**
  - хост регистрирует плагины → `initializePlugins()` → наполняет очередь (`enqueue`) → `play()`;
  - разрешение трека: политика → `SourceProvider.resolve()` → `ResolvedSource` → первый
    `PlaybackEngine`, у которого `canPlay()` вернул true → `load()`/`play()` или `setPlaybackPlan()`/`play()`;
  - автопереход по `ended` / `playbackExhausted` с учётом shuffle/repeat;
  - восстановление снимка `CoreState` (`restoreState`) и проверка доступности источников
    по запросу хоста (`inspectSourceAvailability`).

## 2. Архитектурная модель

```
apps/* (хосты)  ──импортируют──▶  packages/plugins/*/*  ──импортируют──▶  @unitrack/core/types
      │                                   │
      └──────▶ @unitrack/core ◀───────────┘ (только types: CONTRACT_VERSION, *_CAPABILITY_KEYS)
                    │
                    └── CorePlayer ─┬─ QueueManager (приватный)
                                    ├─ PluginRegistry
                                    ├─ resolveTrack (Resolver.js)
                                    └─ EventEmitter (собственный, не node:events)
```

| Модуль (`packages/core/src`) | Ответственность |
| --- | --- |
| `CorePlayer.js` | Публичный API: транспорт (`play/pause/stop/next/prev/seek`), команды очереди, громкость, политика, `getState()`, `restoreState()`, `inspectSourceAvailability()`, жизненный цикл плагинов (`initializePlugins`/`dispose`). Оркестрация движка, ревизии `PlaybackPlan`, публичные события. |
| `Queue.js` (`QueueManager`) | Каноническая очередь `QueueItem[]`, текущий индекс, shuffle-история, repeat. Генерирует `queueItemId` (`qi_N`). Эмитит `changed`. |
| `Resolver.js` (`resolveTrack`, `TrackResolutionError`) | Обход `SourcePolicyRule[]` → подходящие `SourceRef` → провайдер; одна повторная попытка через `revalidate()` для провайдеров с `requiresRevalidation`. Собирает `failedSources`. |
| `PluginRegistry.js` (`PluginContractError`) | Хранение плагинов по категориям, структурная валидация при регистрации, выбор движка по `canPlay()` в порядке регистрации. |
| `types.js` | JSDoc-типы контракта и **рантайм-значения**: `CONTRACT_VERSION`, `SOURCE_PROVIDER_CAPABILITY_KEYS`, `PLAYBACK_ENGINE_CAPABILITY_KEYS`. |
| `EventEmitter.js` | Минимальный pub/sub без Node built-ins; ошибки слушателей собираются в `AggregateError`. |

Публичный экспорт ядра (`src/index.js`): `CorePlayer`, `PluginsNotInitializedError`,
`TrackResolutionError`, `PluginContractError`, `CONTRACT_VERSION`. Подпуть `@unitrack/core/types` —
для плагинов.

Публичные события `CorePlayer`: `stateChanged`, `trackChanged`, `queueChanged`,
`positionChanged` (троттлинг 250 мс), `error` (`{ queueItemId, trackId, reason, failedSources[] }`
с редактированными токенами).

**Направление зависимостей:** хост → плагины / shared → `@unitrack/core/types`. Ядро не
импортирует ни один плагин или shared-пакет. Плагины не импортируют друг друга.

## 3. Структура проекта

| Путь | Содержимое |
| --- | --- |
| `packages/core` | `@unitrack/core`. Платформенно-независимо: ни Node API, ни DOM, ни runtime-зависимостей. |
| `packages/plugins/any/<name>` | Плагины без платформенных API (только `fetch`, Web Crypto): `source-subsonic`, `source-s3`, `source-direct-url`. **Точка расширения.** |
| `packages/plugins/web/<name>` | Плагины на DOM/Web Audio (браузер, Electron renderer): `engine-web-audio`, `engine-audio-queue`. **Точка расширения.** |
| `packages/plugins/desktop/<name>` | Плагины на Node API (`node:fs`): `source-local-fs`, `playlist-local-fs`, `metadata-local-fs`. **Точка расширения.** |
| `packages/shared/<name>` | Не-плагинный общий код без собственной plugin identity: `conformance-kit`, `media-delivery-web` (внутренний, только для web-движков), `util-fs` (Node-only), `ts-consumer-fixture` (проверка `.d.ts` из настоящего `.ts`). |
| `apps/electron-demo` | Electron-хост; плагины в `preload.mjs`, `metadata-local-fs` — в `main.js` через IPC `fetch-metadata`. Без автотестов (проверяется вручную). |
| `apps/web-demo` | Браузерный хост без бандлера: `server.js` строит import map из `package.json.exports` пакетов `node_modules/@unitrack/*`. |
| `docs/superpowers/specs`, `docs/superpowers/plans` | Design-спеки (`YYYY-MM-DD-<topic>-design.md`) и планы реализации. |

Workspaces (корневой `package.json`): `packages/core`, `packages/shared/*`, `packages/plugins/*/*`, `apps/*`.
Глоб не рекурсивный — новый пакет должен лежать ровно на этом уровне вложенности.

## 4. Ключевые сущности и термины

Полные определения — в `CONTEXT.md` и JSDoc `packages/core/src/types.js`.

- **`LogicalTrack`** `{ id, metadata, sources: SourceRef[] }` — идентичность трека, не файл и не URL.
- **`SourceRef`** `{ pluginId, token: SourceToken, kind, displayName? }` — один кандидат-источник.
  `pluginId` маршрутизирует к провайдеру, `kind` используется правилами политики.
- **`SourceToken`** `{ pluginId, token, displayPath? }` — непрозрачный хэндл провайдера.
  `token` интерпретирует только выпустивший его провайдер; `displayPath` безопасно показывать.
- **`ResolvedSource`** `{ kind: 'url'|'stream'|'buffer', url?, stream?, buffer?, mime, headers?, bitrate? }` —
  краткоживущий дескриптор доставки. Сейчас все производители и движки работают только с `kind: 'url'`.
- **`SourcePolicyRule`** `{ kind?, pluginId? }` — правило выбора; пустое правило `{}` соответствует всем
  источникам в порядке `track.sources` (так настроены оба демо-хоста).
- **`QueueItem`** `{ queueItemId, track }` — вхождение трека в очередь; один трек может встречаться
  несколько раз.
- **Каноническая очередь** — очередь, которой владеет только `CorePlayer`.
- **`PlaybackPlan`** `{ revision, entries: PlaybackPlanEntry[] }` — одноразовый lookahead-снимок
  (окно `DEFAULT_LOOKAHEAD_WINDOW = 3`, включая текущий), не вторая очередь.
- **Capabilities** — закрытые списки булевых флагов. Source: `offline`, `requiresRevalidation`.
  Engine: `gapless`, `backgroundPlayback`, `lookaheadPlayback`, опц. `nowPlaying`.
- **`CONTRACT_VERSION`** — версия контракта плагинов (`'0.4.0'`), независимая от npm-версий пакетов.
- **`PluginContext`** `{ log, config, host: { platform, version } }` — передаётся в `initialize()`.
- **Source availability** — `'available'|'providerMissing'|'invalid'|'unchecked'`; не гарантия воспроизведения.
- **Хост / манифест хоста** — приложение и его `plugins.js`, единственное место композиции плагинов.

## 5. Архитектурные границы

### Ответственность

- **Ядро** решает: какой источник выбрать (политика + fallback + revalidate-retry), какой движок взять,
  порядок воспроизведения, shuffle/repeat, переход к следующему треку, состояние плеера.
- **`SourceProvider`** только превращает свой `SourceRef` в `ResolvedSource` и перепроверяет токен.
  Не знает об очереди и движках.
- **`PlaybackEngine`** только воспроизводит `ResolvedSource` и сообщает о фактических событиях
  (`progress`, `ended`, `error`, `playbackStarted`, `playbackExhausted`). Может оптимизировать переходы
  внутри выданного плана, но **не принимает решений о политике очереди** и не знает о repeat/shuffle
  (repeat `'one'` ядро выражает повтором записи в плане).
- **Хост** решает: какие плагины регистрировать, политику, когда вызывать `inspectSourceAvailability`,
  персистентность `CoreState`, обработку `transportCommand` (ядро её намеренно не подписывает),
  использование `MetadataProvider`/`PlaylistProvider`.

### Допустимые зависимости

- Плагин → `@unitrack/core/types` (как devDependency) и, при необходимости, пакеты из `packages/shared/*`
  (`media-delivery-web` — только web-движки; `util-fs` — только desktop-плагины).
- Хост → `@unitrack/core` и плагины, импортируемые через свой `plugins.js`.
- `any`-плагин — только API, одинаковые везде (`fetch`, `URL`, `AbortController`, Web Crypto).
  `web` — плюс DOM/`HTMLAudioElement`/Web Audio. `desktop` — плюс `node:*`.

### Нарушения архитектуры

- Импорт Node API, DOM или сторонних runtime-пакетов в `packages/core`; использование `node:events`
  вместо собственного `EventEmitter`.
- Импорт ядром любого плагина или shared-пакета; импорт одного плагина другим.
- Импорт `desktop`-плагина в браузерный хост; Node/DOM API в `any`-плагине.
- Мутация очереди в обход команд `CorePlayer` (`enqueue`, `removeFromQueue`, `reorderQueueItem`,
  `clearQueue`, `selectQueueItem`, `setShuffle`, `setRepeatMode`); вынос `QueueManager` в публичный API.
- Движок, владеющий очередью или сам решающий «что дальше» вне выданного плана; старт записи
  из устаревшей ревизии плана.
- Публичная команда `CorePlayer`, не проходящая через `#enqueue` (цепочку сериализации операций).
- Разбор `SourceToken.token` кем-либо, кроме выпустившего провайдера; эвристическое примирение
  несовпадающих `SourceRef.pluginId` и `token.pluginId` (такой ref — невалидный ввод).
- Попадание `token.token` или `ResolvedSource.headers` в логи, события, сообщения об ошибках, UI.
  Допустимо: `pluginId`, `kind`, `displayPath`, редактированный origin URL, код причины.
- Учётные данные, встроенные в URL, когда их можно передать через `ResolvedSource.headers`
  (JSDoc `types.js`: «credentials belong here, never embedded in the URL itself»). Существующие
  `source-s3` (presigned URL) и `source-subsonic` (token+salt в query) подписывают сам URL — это
  особенность их протоколов; не воспроизводить этот подход без такой причины.
- Подключение `media-delivery-web` как публичной категории плагинов или API ядра.
- Добавление capability-ключа без изменения закрытого списка в `types.js` и `PluginRegistry`.

## 6. Точки расширения

| Что добавить | Где | Контракт / механизм |
| --- | --- | --- |
| Новый источник | `packages/plugins/<any\|web\|desktop>/source-<name>` | `SourceProvider` (`types.js`): `id`, `kind`, `contractVersion: CONTRACT_VERSION`, `capabilities`, `initialize`, `canResolve`, `resolve`, `revalidate`, `dispose`. Фабрика `createXxxSourceProvider(config)`, `id` обычно настраиваемый; `canResolve` сверяет `ref.pluginId === id`. |
| Новый движок | `packages/plugins/web/...` (или другой уровень) | `PlaybackEngine`. При `lookaheadPlayback: true` обязателен `setPlaybackPlan(plan)` и события `playbackStarted`/`playbackExhausted` с `{ queueItemId, planRevision }`; ревизию ≤ текущей игнорировать. При `nowPlaying: true` обязателен `setNowPlaying`. Неподдерживаемый `ResolvedSource.kind` → `canPlay()` возвращает `false`. |
| Метаданные / плейлисты | `packages/plugins/<tier>/metadata-*`, `playlist-*` | `MetadataProvider` (`search`, опц. `fetchForSource`), `PlaylistProvider` (`fetchPlaylist`, опц. `listPlaylists`). Вызываются хостом напрямую. |
| Общий не-плагинный код | `packages/shared/<name>` | Без plugin identity. |
| Новый хост | `apps/<name>` + `plugins.js` | Манифест: импорт фабрик и `PLUGIN_MANIFEST`; без флагов сборки и динамического обнаружения. |
| Проверка плагина | `test/conformance.test.js` в пакете | `@unitrack/conformance-kit`: `assertSourceProviderConformance`, `assertPlaybackEngineConformance`, `assertMetadataProviderConformance`, `assertPlaylistProviderConformance`. |
| Изменение контракта | `packages/core/src/types.js`, `PluginRegistry.js`, `conformance-kit`, все first-party плагины | Ломающее изменение = bump `CONTRACT_VERSION` (точное совпадение при регистрации) и миграция всех плагинов, хостов, фикстур. По процессу репозитория предваряется design-спекой. |

Шаблон нового пакета повторяет существующие: `"type": "module"`, `exports` с условиями
`types` → `./dist/*.d.ts` и `import` → `./src/*.js`, скрипты `test` (`node --test test/*.test.js`),
`typecheck` (`tsc -p tsconfig.json`), `build:types` (`tsc -p tsconfig.build.json`).
Для DOM-кода в `tsconfig.json` указывается `"lib": ["ES2022", "DOM"]`.

## 7. Важные ограничения

- **Нет шага сборки JS.** Исполняется `src/*.js`; `dist/` (gitignored) содержит только `.d.ts`.
  Не вводить TypeScript-исходники (кроме `ts-consumer-fixture`) и бандлеры.
- **Типы — через JSDoc**, проверка `tsc --checkJs --strict`. CI (`.github/workflows/ci.yml`, Node 20 и 22):
  `npm ci` → `npm test` → `npm run build:types` → `npm run typecheck` (typecheck зависит от собранных `.d.ts`).
- **Тесты — `node --test`** без фреймворков и mock-библиотек; окружение имитируется рукописными
  стабами (`test/helpers/domStubs.js`, `fetchStubs.js`, `testServer.js`, `packages/core/test/helpers/mockPlugins.js`).
- **Node:** `>=18` для большинства пакетов; `@unitrack/metadata-local-fs` — `>=22`.
- **`initializePlugins()` обязателен до `play()`** (иначе `PluginsNotInitializedError`); вызывает
  `initialize()` только у source-провайдеров и движков. Хосты вызывают его повторно после регистрации
  нового провайдера — `initialize()` плагинов должен быть идемпотентным.
- **Мутации очереди не прерывают звучащий трек** — они лишь пересобирают план (новая ревизия).
- **Известные ограничения lookahead** (задокументированы в `CorePlayer.#resolveLookaheadPlan`):
  план строится в порядке массива, а не по shuffle-истории, и не заворачивается при repeat `'all'`
  (переход на начало идёт полной перезагрузкой, не gapless).
- **`ResolvedSource.mime` обязателен**; неизвестный тип для HTTP-источников, идущих в web-движки, —
  пустая строка `''` (движки трактуют falsy как «разрешить»; `'application/octet-stream'` даёт
  `canPlayType() === ''` и делает источник непроигрываемым).
- **Заголовки в web-движках:** `<audio>` не умеет слать заголовки, поэтому `acquireWebMediaUrl`
  при наличии `headers` скачивает ресурс целиком в Blob (CORS и память). Лизы нужно освобождать
  при смене источника, `stop()` и `dispose()`.
- **Сбой разрешения будущей записи плана не фатален** — запись пропускается; ошибка возникает,
  только если воспроизведение до неё дойдёт.
- **Порядок движков значим:** выбирается первый зарегистрированный с `canPlay() === true`.
- **Electron-демо:** `metadata-local-fs` работает только в main-процессе (через IPC), DOM-плагины — только в preload.
- **Процесс изменений:** design-спека → план → реализация в ветке → PR; коммиты — Conventional Commits.
