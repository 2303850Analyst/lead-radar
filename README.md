# LeadRadar

Текущая версия: **0.4.0-alpha.1**

LeadRadar — локальный MVP для обнаружения потенциальных B2B-клиентов среди
малозаметных и слабо оцифрованных компаний. Пользователь задаёт основной и
смежные запросы, географию и свои услуги, а приложение формирует объяснимую
выборку организаций.

LeadRadar — **discovery-система, а не полный реестр рынка**. Поисковый источник
возвращает релевантную выборку и не гарантирует, что найдены все компании.

## Возможности текущей alpha-сборки

- создание поискового задания на русском языке;
- основной запрос, смежные запросы и исключения;
- предварительное понимание свободного запроса через open-vocabulary
  `SemanticIntentV2`: Kimi формулирует цель, основные, смежные и исключаемые
  типы бизнеса, услуги, сигналы и retrieval terms без списка готовых ниш;
- strict Structured Output с локальной проверкой размера, формы, смысловых
  инвариантов и запретом URL, координат и исполняемых provider-параметров;
- показ трактовки до обращения к картам и подтверждение неоднозначных запросов;
- пилотные locale/country-контракты для RU, BY и KZ;
- четыре представления: поиск, таблица, карта и карточка лида;
- интерактивная карта OpenStreetMap для выбора точного центра и радиуса поиска;
- карта результатов открывается на выбранной области, по умолчанию — на Москве;
- пять кликабельных режимов географии: город, район, метро, область и ручной
  радиус;
- выбор конкретной станции во всех семи городах России с действующим метро,
  поиском по названию и переносом центра карты на станцию;
- серверное определение центра по городу, району, региону или адресу;
- фильтрация, сортировка, пагинация и CSV для разрешённых данных;
- кликабельные ссылки на сайты в таблице и карточке лида;
- статусы, заметки и локальное сохранение результатов разрешённых источников;
- серверные `GET/POST /api/search`, `POST /api/geocode` и
  `GET /api/metro-stations`;
- живой прогресс поиска через NDJSON без изменения обычного JSON-контракта;
- отдельный `POST /api/search/plan`, который не расходует квоту Geoapify;
- детерминированный demo-режим без ключа;
- live-поиск через Geoapify Geocoding и Places API;
- серверное хранение API-ключа без передачи в браузер;
- provider-метаданные, происхождение каждой карточки и обязательная атрибуция;
- подготовленный контракт для будущих поставщиков данных без реализованного
  автоматического fallback;
- экспериментальный адаптер Яндекса, выключенный до лицензионного подтверждения.

## Быстрый запуск

Требования: Node.js `>=22.13.0` и npm.

```powershell
npm install
npm run build
npm run start
```

Откройте [http://localhost:3000](http://localhost:3000). Dev-сервер по умолчанию
привязан только к `127.0.0.1`, чтобы другие устройства в сети не расходовали
квоту Geoapify через локальный API.

`npm run dev` остаётся режимом разработки с горячей перезагрузкой. На Windows
плагин Cloudflare иногда завершается внутри `workerd`; проверенный путь для
локального использования MVP — production build и `npm run start`.

Без дополнительных настроек приложение использует синтетические demo-данные и
детерминированное понимание категорий. Реальный Kimi не обязателен для знакомых
таксономии запросов.

Для live-поиска создайте `.env.local`:

```env
GEOAPIFY_API_KEY=новый_серверный_ключ
SEARCH_PROVIDER=geoapify
GEOAPIFY_PLACES_LIMIT=100
GEOAPIFY_DETAILS_LIMIT=20
```

Перед внешним deployment отзовите использованный dev-ключ, если он когда-либо
публиковался в чате, логе или скриншоте, и выпустите новый. Инструкция находится в
[`docs/geoapify-setup.md`](docs/geoapify-setup.md). После изменения окружения
перезапустите сервер.

Для Kimi planner положите ключ во внешний, не входящий в проект файл
`C:\Users\<пользователь>\.sa-trainer-secrets\kimi.env`:

```env
KIMI_API_KEY=ваш_ключ_Moonshot
```

Затем запускайте production build через wrapper:

```powershell
npm run build
.\scripts\run-with-kimi-secret.ps1 -NpmScript start
```

Wrapper передаёт ключ только дочернему процессу, включает
`QUERY_INTELLIGENCE_MODE=kimi` и при необходимости создаёт временный signing
secret. Другой путь можно передать через server-side переменную
`KIMI_SECRET_FILE`; без `-NpmScript start` wrapper запускает `dev`. После
перезапуска выданные ранее confirmation tokens станут
недействительными. Для постоянной среды задайте отдельный стабильный
`SEARCH_PLAN_SIGNING_SECRET` длиной не менее 32 байт в secret storage.
`KIMI_LEAD_CLASSIFICATION_ENABLED` оставляйте `false`: текущий alpha выполняет
relevance локально и не отправляет найденные карточки модели.

### Локальный запуск в Docker

Docker-сборка запускает тот же production build на
[http://127.0.0.1:3000](http://127.0.0.1:3000) и не открывает API другим
устройствам в локальной сети. Контейнер ограничен `0,5 CPU`, `256 МБ` памяти,
Node.js heap `160 МБ` и `64` процессами; корневая файловая система доступна
только для чтения. Секреты не попадают в образ и подаются лишь при запуске из
локальных env-файлов.

Чтобы подключить существующий Kimi-ключ и Geoapify-конфигурацию:

```powershell
$env:KIMI_SECRET_FILE="C:/Users/<пользователь>/.sa-trainer-secrets/kimi.env"
npm run docker:up
```

Compose автоматически прочитает игнорируемый Git файл `.env.local`, если он
существует. Без ключей сервис запустится в demo/deterministic режиме. Проверка и
остановка:

```powershell
docker compose ps
npm run docker:down
Remove-Item Env:KIMI_SECRET_FILE -ErrorAction SilentlyContinue
```

Лимиты относятся к работающему контейнеру; во время первой сборки Docker может
кратковременно использовать больше CPU и памяти. Если реальный поиск стабильно
завершается по OOM, увеличьте только `mem_limit` в `compose.yaml` до `320m`.

## Проверка проекта

```powershell
npm run quality
```

`npm run quality` запускает ESLint, строгий TypeScript, production build,
автотесты и offline evaluation. Реальный Kimi не вызывается обычными тестами.
Open-world gate можно воспроизвести отдельно:

```powershell
npm run eval:open-world
npm run eval:relevance
```

Первая команда проверяет 500 замороженных CIS intent-сценариев через mock Kimi
и реальный planner/compiler. Вторая — 600 явно размеченных синтетических
candidate-evidence сценариев по 150 provider targets через фактический
deterministic relevance runtime. Retrieval-контекст хранится отдельно от
golden label, а prompt-injection равномерно покрывает все четыре статуса. В
stdout попадают
только агрегаты, версии и checksum; запросы, лиды и ответы провайдеров не
записываются.

Опциональный live canary запускается явно, чтобы случайно не расходовать квоту:

```powershell
$env:RUN_KIMI_LIVE_EVAL="1"
.\scripts\run-with-kimi-secret.ps1 -NpmScript eval:kimi:live
Remove-Item Env:RUN_KIMI_LIVE_EVAL
```

Скрипт записывает в игнорируемый `work/evaluations/` только canonical IDs,
статусы, latency и token usage. Prompt, ключ, reasoning и карточки компаний не
сохраняются.

## API приложения

### `GET /api/search`

Возвращает health, версию `0.4.0-alpha.1`, активный режим и безопасные признаки
конфигурации провайдеров. Значения API-ключей, upstream URL с ключом и полные
ответы внешнего источника в health не возвращаются. При
`SEARCH_PROVIDER=geoapify` и рабочем `GEOAPIFY_API_KEY` активным режимом является
`geoapify`; при явном `SEARCH_PROVIDER=demo` используется синтетическая выборка.

Сокращённый health-ответ настроенного live-режима:

```json
{
  "status": "ok",
  "service": "LeadRadar Search API",
  "version": "0.4.0-alpha.1",
  "mode": "geoapify",
  "searchProvider": "geoapify",
  "geoapifyConfigured": true,
  "geoapifyKeyConfigured": true,
  "capabilities": {
    "queryIntelligence": {
      "configured": true,
      "mode": "kimi",
      "model": "kimi-k3",
      "strictStructuredOutput": true
    },
    "geoapifyPlaces": {
      "configured": true,
      "placesLimit": 100,
      "detailsLimit": 20,
      "retrievalLimits": {
        "maxArms": 4,
        "maxUpstreamRequests": 4,
        "maxCards": 200,
        "maxDetails": 50
      },
      "strictRadius": true,
      "countryFilter": "ru",
      "supportedCountryCodes": ["RU", "BY", "KZ"],
      "rawResponsesStored": false
    },
    "metroStations": {
      "configured": true,
      "systems": [
        { "id": "moscow", "city": "Москва" },
        { "id": "saint-petersburg", "city": "Санкт-Петербург" }
      ],
      "source": "Geoapify / OpenStreetMap",
      "typedGeocodeFallback": true,
      "rawResponsesStored": false
    }
  }
}
```

`countryFilter: "ru"` сохраняет прежний default для старого payload;
`supportedCountryCodes` описывает новый явный контракт. В alpha за один поиск
разрешена ровно одна страна.

### `POST /api/geocode`

Определяет координаты города, района или адреса через серверный Geoapify
Geocoding API. Ключ остаётся на сервере.

```json
{
  "location": "Москва, ул. Лесная, 7"
}
```

Успешный ответ содержит `coordinates` в порядке `[долгота, широта]`, исходный
`location` и `provider`. Интерфейс использует этот endpoint, чтобы поставить
маркер на карте; пользователь затем может перенести маркер или выбрать другую
точку кликом.

### `GET /api/metro-stations`

Возвращает нормализованные станции одного из семи действующих метрополитенов
России. Город задаётся стабильным ID:

```text
GET /api/metro-stations?city=moscow
GET /api/metro-stations?city=samara&q=Гагаринская
```

Поддержанные ID: `moscow`, `saint-petersburg`, `novosibirsk`,
`nizhny-novgorod`, `samara`, `yekaterinburg`, `kazan`. Без `q` endpoint
возвращает обнаруженный каталог Geoapify/OpenStreetMap; с `q` сначала фильтрует
его, а при нулевом результате использует точный Geocoding + Place Details
fallback. Ответ содержит только нормализованные названия, координаты, цвета
линий и provider IDs, но не API-ключ и не полный upstream response. Каталог
кэшируется в памяти процесса на 24 часа и может быть отдан из устаревшего кэша
при временной ошибке провайдера. Уточняющий поиск принимает минимум два символа,
имеет отдельные клиентский и глобальный минутные лимиты, общий deadline 30
секунд и проверяет не более трёх кандидатов через Place Details.

Пример выбора метро в поисковом payload:

```json
{
  "location": "Метро «Белорусская», Москва",
  "locationMode": "metro",
  "metro": {
    "systemId": "moscow",
    "stationId": "geoapify:<place-id>",
    "stationName": "Белорусская"
  },
  "center": [37.58515, 55.77595],
  "radiusKm": 1.5
}
```

Для `locationMode: "metro"` станция и `center` обязательны, страна/локаль должны
быть `RU`/`ru-RU`, радиус ограничен диапазоном 0,5–10 км, а координаты обязаны
попадать в область выбранного метрополитена. Перед поиском сервер повторно
проверяет provider ID, название и координаты через Place Details и использует
канонические координаты источника; подтверждение кэшируется на 24 часа. Старые
клиенты без `locationMode` сохраняют прежнее поведение кругового радиуса.

### `POST /api/search/plan`

Интерпретирует запрос и не обращается к Geoapify. Вход совпадает с поисковым
заданием; дополнительно поддерживаются `locale` и одна страна:

```json
{
  "description": "Место, где стригут мужчин",
  "primaryQuery": "мужская стрижка",
  "relatedQueries": [],
  "excludeQueries": ["груминг животных"],
  "locale": "ru-RU",
  "countryCodes": ["RU"]
}
```

Ответ содержит `SearchPlan` версии `2.2` со статусом `ready`,
`needs_confirmation`, `unsupported` или `degraded`, объектом
`semanticIntent`, отдельной уверенностью в смысле запроса и покрытии источника,
версиями prompt/schema, usage, latency и проверяемыми hash. Вложенный
`SemanticIntentV2` сохраняет собственную schema `2.0`. Во время миграции
плана в нём также сохраняются legacy canonical IDs для уже поддерживаемых ниш;
они вычисляются сервером после Kimi и не передаются модели. `needs_confirmation`
на этом endpoint является обычным HTTP 200: UI должен показать трактовку и не
запускать карты до подтверждения.

### `POST /api/search`

Обязателен `primaryQuery`; географию задаёт текстовый `location` или координаты
`center`. Радиус по умолчанию — 15 км.

```json
{
  "description": "Компании, которые оказывают услуги фулфилмента",
  "primaryQuery": "Фулфилмент",
  "relatedQueries": [
    "Ответственное хранение",
    "Складские услуги",
    "Комплектация заказов"
  ],
  "excludeQueries": ["Камеры хранения", "Аренда гаражей"],
  "location": "Москва",
  "center": [37.6173, 55.7558],
  "radiusKm": 15,
  "offer": "Оцифровка обработки заявок и внедрение CRM",
  "services": ["Создание сайта", "CRM", "Автоматизация"],
  "locale": "ru-RU",
  "countryCodes": ["RU"]
}
```

Поле `center` необязательно. Если оно передано, поиск использует выбранную точку
без повторного геокодирования `location`. Старые клиенты могут по-прежнему
передавать только текстовую географию.

Обычный endpoint возвращает JSON с параметрами запроса, provider-метаданными,
сводкой и массивом `leads`. У каждого лида есть массив `sources` с provider ID,
внешним ID и временем наблюдения. Ошибки валидации возвращаются с HTTP 400.
Неоднозначный intent возвращает HTTP 409 с
`SEARCH_PLAN_CONFIRMATION_REQUIRED`, неподдерживаемый — HTTP 422 с
`SEARCH_PLAN_UNSUPPORTED`. Ошибка live-провайдера возвращается с HTTP 502 и не
подменяется демоданными.

Чтобы продолжить неоднозначный поиск, повторите тот же payload и передайте
ровно одну показанную semantic alternative вместе с подписанным token:

```json
{
  "confirmedAlternative": {
    "alternativeId": "alt-из-SearchPlan",
    "alternativeHash": "hash_из_SearchPlan",
    "semanticIntent": "полный semanticIntent выбранной alternative без изменений"
  },
  "confirmationToken": "token_из_SearchPlan"
}
```

Token действует 10 минут и подписывает исходные request/plan hash, допустимые
alternative hash и версии semantic/compiler contracts. Сервер заново валидирует
и хэширует выбранный `SemanticIntentV2`; V1 token с canonical IDs не исполняется
и требует безопасно сформировать новый план.

### `POST /api/search?stream=1`

Возвращает `application/x-ndjson`: отдельные JSON-строки показывают этапы
`validation`, `intent_resolution`, optional `geocoding`,
`provider_compilation`, `places`, `relevance_classification`, `details`,
`normalizing` и `complete`.
Последняя строка содержит либо итоговый `{ "type": "result", "data": ... }`,
либо структурированную ошибку `{ "type": "error", ... }`. Веб-интерфейс
использует этот режим для живого индикатора, а JSON-вариант `/api/search`
остаётся доступным для существующих интеграций.

В local Tier-0 profile весь запрос, включая ожидание Kimi admission, ограничен
60 секундами. Progress heartbeat отправляется не реже одного раза в 2 секунды,
пока стадия выполняется. На исчерпании общего бюджета JSON возвращает HTTP 504
с `SEARCH_DEADLINE_EXCEEDED`, а NDJSON — ровно одну terminal error-строку.
Client disconnect отменяет общий `AbortSignal`, Kimi SSE, запросы провайдера,
ожидания и enrichment. Если времени не хватает только на optional classifier
или Details, базовые карточки сохраняются, а
`provider.coverage.degradedStages` явно указывает пропущенную стадию.

Для уже запущенного локального сервера есть обезличенный end-to-end smoke:

```powershell
npm run smoke:stream
```

Default smoke использует zero-overlap формулировку и при Kimi-режиме проверяет
всю цепочку до Geoapify. Запрос можно заменить через `SMOKE_SEARCH_QUERY`.

## Live-поиск Geoapify

LeadRadar серверно геокодирует город или адрес, затем ищет организации через
Geoapify Places API. Основной запрос для фулфилмента использует категории
`office.logistics` и `rental.storage`. Более широкая `building.industrial`
намеренно исключена из live-поиска MVP: в контрольной выборке она возвращала
преимущественно безымянные промышленные объекты и вытесняла карточки организаций.

Geocoding, Places и Place Details проверены реальным transient smoke test.
Конкретные агрегаты и дата находятся в [`changes_log.md`](changes_log.md), чтобы
стабильный README не превращался в хронологический журнал. Такая проверка
подтверждает транспорт и одну выборку, но не полноту рынка.

Geoapify остаётся единственным live-провайдером версии `0.4.0-alpha.1`.
Автоматический
fallback пока не реализован: timeout, `429` или `5xx` возвращаются как ошибка
источника и не маскируются demo-данными. Черновик будущего failover находится в
[`docs/geoapify-setup.md`](docs/geoapify-setup.md).

Free plan требует видимую атрибуцию Geoapify и OpenStreetMap. Она сохраняется
на экранах live-результата и в CSV-экспорте. Использованный для локального теста ключ нужно
заменить перед внешним deployment, поскольку он ранее появился вне server-side
окружения.

## Query Intelligence и Kimi

В режиме Kimi planner передаёт модели только нормализованные пользовательские
поля категории, locale и страну. Модель не получает список canonical
кандидатов, карточки организаций, контакты, географические координаты или
категории Geoapify. Она возвращает `SemanticIntentV2` с открытой отраслевой
лексикой; сервер проверяет strict JSON Schema, лимиты, смысловые инварианты и
отсутствие исполняемых URL/filters.

После semantic encoding сервер сопоставляет provider-neutral английские
retrieval terms полному зафиксированному каталогу Geoapify: 813 категорий из
официальной документации, версия и SHA-256 checksum доступны в health API.
Компилятор формирует до четырёх независимых retrieval arms: точный, расширенный,
смежный и безопасный поиск по названию. У каждого есть стабильный ID,
приоритет, происхождение из `SemanticIntentV2` и собственный лимит результата;
общий серверный предел — четыре Places-запроса и 200 наблюдённых карточек.
Если узкой категории нет, сервер использует фиксированный широкий scope из
registry вместе с ограниченным `name`, а не исполняет категорию из текста
модели. Каждый category ID повторно проверяется перед отправкой провайдеру.
Старый словарь 40 ниш остаётся только fallback обратной совместимости.

Карточки из разных arms дедуплицируются до получения Details и сохраняют все
причины обнаружения. Точные, смежные и fallback-находки различимы в
`SearchPlan.executionPreview.retrievalArms` и `Lead.discovery.retrievalArms`.
Исключения из пользовательского задания и `SemanticIntentV2` применяются по
доступным названию, provider categories и короткому source description до
расхода квоты Details.

Open-vocabulary encoder проверен на реальном `kimi-k3` для трёх обычных
формулировок: барбершоп, спортивный зал и ремонт телефонов. Валидные ответы
заняли 13,8–30,3 с; два промежуточных вызова достигли текущего timeout 30 с.
Это функциональный canary и аргумент для отдельной калибровки deadline, а не
доказательство SLA. Два успешных live smoke «Спортивный зал» прошли через Kimi
и Geoapify за 27,4–27,7 с: готовый provider plan, 3–20 обнаруженных карточек и
3 из 3 запрошенных Details; raw ответы и лиды не сохранялись.

## Экспериментальный API Яндекса

Адаптер Яндекса сохранён, но выключен по умолчанию. До письменного подтверждения
Яндекса не используйте его ответы для постоянного хранения, собственного
scoring, CSV или отображения поверх сторонней карты. Изолированный сценарий
описан в [`docs/yandex-live-test.md`](docs/yandex-live-test.md).

## Ограничения

- Это локальный alpha: production release `v0.4.0` ещё имеет решение `NO-GO`.
- Open-vocabulary semantic encoder и полный registry уже не ограничены 40
  concepts. Frozen planner gate достиг 500/500 CIS intent cases и включает 100
  типов физических организаций, но использует golden mock Kimi и поэтому не
  доказывает качество live-модели. Deterministic relevance gate достиг 600/600
  синтетических карточек; optional Kimi-classifier остаётся `N/A` до отдельного
  data-flow/rate разрешения и live evaluation.
- Runtime deterministic relevance уже заполняет `Lead.relevance` до Details по
  названию, provider categories, короткому описанию, географии и исключениям.
  Статусы `matched`, `maybe`, `rejected`, `not_checked` видны в таблице, карте,
  карточке и CSV; `rejected` не скрывается. Optional Kimi-classifier остаётся
  выключенным, поэтому реальные карточки модели по умолчанию не передаются.
- RU поддерживается, BY/KZ являются пилотными; остальные страны CIS пока
  возвращают контролируемый unsupported.
- In-process Tier-0 scheduler, admission queue, circuit breaker и единый
  server-side deadline работают только в одном экземпляре Node.js. Нет auth,
  shared/distributed limiter, multi-tenancy или межпроцессной координации;
  live API предназначен только для владельца на `127.0.0.1`.
- Несколько live canary-вызовов не подтверждают p95: внешний SLA отсутствует.
- Provider boundary мигрирован частично: retrieval arms уже компилируются из
  открытого intent, а exclusions и дедупликация выполняются до Details, но
  geocoding и enrichment ещё не вынесены в отдельный двухфазный search service.
- До восьми поисковых терминов на одно задание.
- Круговой радиус от 0,5 до 250 км; произвольный полигон отсутствует.
- Режимы города, района и области в текущем alpha используют геокодированный
  центр и круговой охват, а не точную административную границу.
- Справочник метро покрывает все семь действующих систем России, но основан на
  Geoapify/OpenStreetMap и не является официальным нормативным реестром;
  временно закрытые станции могут отсутствовать в основной выдаче.
- Geoapify Places ищет по категориям и не является исчерпывающим
  полнотекстовым реестром компаний.
- Полнота телефонов, email, сайтов и социальных сетей зависит от исходных
  открытых данных.
- Автоматический fallback и агрегация нескольких источников ещё не реализованы.
- Исключения применяются до Details по названию, provider categories и
  короткому source description; результат остаётся видимым как `rejected`.
- Отсутствие URL означает только «сайт не указан в карточке источника».
- Сайты и социальные сети в live-режиме не проверяются.
- Scoring является эвристикой, а не прогнозом сделки.
- Для постоянной базы, enrichment, экспорта и CRM нужен источник или лицензия,
  разрешающие обработку и хранение данных.

## Документация проекта

- [`ROADMAP.md`](ROADMAP.md) — этапы развития и критерии готовности.
- [`changes_log.md`](changes_log.md) — журнал бизнес-логики и существенных решений.
- [`docs/geoapify-setup.md`](docs/geoapify-setup.md) — настройка, тариф,
  атрибуция, live test и черновик fallback.
- [`docs/yandex-live-test.md`](docs/yandex-live-test.md) — изолированная проверка
  экспериментального адаптера Яндекса.
- [`docs/semantic-query-planner-architecture.md`](docs/semantic-query-planner-architecture.md)
  — границы AI, SearchPlan, SLO-гипотезы и целевая production-архитектура.
- [`docs/v0.4.0-query-intelligence-spec.md`](docs/v0.4.0-query-intelligence-spec.md)
  — исполнимое ТЗ и release quality gates.
- [`docs/evaluations/v0.4.0-alpha.1-query-intelligence.md`](docs/evaluations/v0.4.0-alpha.1-query-intelligence.md)
  — обезличенный initial evaluation report и решение `NO-GO` для production.
- [`AGENTS.md`](AGENTS.md) — постоянные правила версий и релизов.

README имеет стабильную структуру и не используется как хронологический журнал.
История изменений ведётся в `changes_log.md`.

## Версионирование

- Канонический номер версии находится в `package.json`.
- Готовые релизы используют Semantic Versioning и annotated Git-теги `vX.Y.Z`.
- Alpha-версии остаются без release-тега, пока production quality gates не дали
  `GO`.
- PATCH — исправление без изменения бизнес-правил.
- MINOR — новая возможность или изменение продуктовой логики.
- MAJOR — несовместимое изменение контракта, модели данных или workflow.

## Официальные материалы

- [Geoapify Places API](https://apidocs.geoapify.com/docs/places/)
- [Geoapify Pricing](https://www.geoapify.com/pricing/)
- [Geoapify Pricing Details](https://www.geoapify.com/pricing-details/)
- [Geoapify Terms and Conditions](https://www.geoapify.com/terms-and-conditions/)
- [Kimi API models](https://platform.kimi.ai/docs/models)
- [Kimi Chat API](https://platform.kimi.ai/docs/api/chat)
- [Kimi Structured Output](https://platform.kimi.ai/docs/guide/response_format)
- [Kimi streaming output](https://platform.kimi.ai/docs/guide/utilize-the-streaming-output-feature-of-kimi-api)
- [Kimi rate limits](https://platform.kimi.ai/docs/pricing/limits)

- [API Поиска по организациям](https://yandex.ru/maps-api/docs/geosearch-api/index.html)
- [Формат запроса](https://yandex.ru/maps-api/docs/geosearch-api/request.html)
- [Формат ответа](https://yandex.ru/maps-api/docs/geosearch-api/response.html)
- [Страница продукта](https://yandex.ru/maps-api/products/geosearch-api)
- [Коммерческая документация](https://yandex.ru/dev/commercial/doc/ru/concepts/geosearch)
- [Условия использования](https://yandex.ru/legal/maps_api/ru/)
