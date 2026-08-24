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
- интерактивная карта 2GIS MapGL для выбора точного центра и радиуса поиска;
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
- отдельный `POST /api/search/plan`, который не расходует квоту поискового
  провайдера;
- детерминированный demo-режим без ключа;
- live-поиск организаций по свободному тексту через 2GIS Places API;
- live-поиск через Geoapify Geocoding, Autocomplete, Places и Place Details API;
- серверное хранение поисковых API-ключей; отдельный ограниченный ключ MapGL
  передаётся браузеру только для отрисовки карты;
- provider-метаданные, происхождение каждой карточки и обязательная атрибуция;
- явный выбор между 2GIS, Geoapify и demo без автоматического смешивания
  источников;
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

Для поиска организаций через 2GIS создайте `.env.local`. Geoapify пока
используется для серверной геокодировки введённого адреса:

```env
GEOAPIFY_API_KEY=новый_серверный_ключ
DGIS_API_KEY=новый_серверный_ключ_2gis
DGIS_MAP_KEY=отдельный_браузерный_ключ_2gis_map_tiles
DGIS_DEMO_MODE=true
DGIS_CONTACTS_ENABLED=false
SEARCH_PROVIDER=2gis
```

Перед внешним deployment отзовите использованный dev-ключ, если он когда-либо
публиковался в чате, логе или скриншоте, и выпустите новый. Инструкция находится в
[`docs/2gis-setup.md`](docs/2gis-setup.md). Настройка прежнего Geoapify-поиска
описана в [`docs/geoapify-setup.md`](docs/geoapify-setup.md). После изменения
окружения перезапустите сервер.

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

Сквозной canary фактического production-orchestrator с Kimi, Geoapify и
консервативной ручной оценкой запускается отдельно. Он расходует квоты обоих сервисов и
требует настроенный `GEOAPIFY_API_KEY`:

```powershell
$env:RUN_SEARCH_LIVE_CANARY="1"
npm run canary:search:live
Remove-Item Env:RUN_SEARCH_LIVE_CANARY
```

Canary намеренно включает category hints только внутри своего процесса для
измерения. Рабочий default остаётся `GEOAPIFY_CATEGORY_HINTS_ENABLED=false`.
Флаг управляет только optional fail-soft refinement. Подписанный recovery-план
всегда выполняет один обязательный fail-closed Autocomplete resolver до Places.
Production worker собирается до загрузки Kimi key, а SHA-256 фактически
запущенного bundle и canary harness входят в агрегатный отчёт. После сбора
выдачи команда печатает transient URL: откройте его, примените
показанный rubric и в течение 45 минут отправьте в `/submit` номера релевантных
позиций из semantic production pool (до 50 на кейс) и отдельного literal
baseline top-10. Метки frozen semantic top-10 выводятся из той же pool-разметки
автоматически. Полный intent, позиции, карточки и session-salted identities
доступны только в памяти этого запуска и не записываются в итоговый файл.
Versioned aggregate дополнительно показывает `attainable@10` и conditional
ranker recall без новых provider-вызовов. Это потолок только уже выполненных
retrieval arms, а не полный recall Geoapify или рынка; он не меняет release
hard gates и итоговый canary verdict. Provider counters различают planned и
completed arms и включают retrieval, Details и category-resolution запросы.
И отчёт, и финальная console-сводка явно классифицируют measured gap:
невалидное измерение, retrieval/source gap, ranking/fusion gap либо достижение
порога fixed-k Precision@10. Низкий executed-arm ceiling останавливает ranker-
only tuning, но сам ещё не доказывает необходимость второго источника: для
этого нужен отдельный Geoapify-only union ceiling и письменное license-решение.
Опубликованный результат находится в
[`docs/evaluations/v0.4.0-alpha.1-search-live-canary.md`](docs/evaluations/v0.4.0-alpha.1-search-live-canary.md).

## API приложения

### `GET /api/search`

Возвращает health, версию `0.4.0-alpha.1`, активный режим и безопасные признаки
конфигурации провайдеров. Значения API-ключей, upstream URL с ключом и полные
ответы внешнего источника в health не возвращаются. При
`SEARCH_PROVIDER=2gis` и рабочем `DGIS_API_KEY` активным режимом является
`2gis`; `SEARCH_PROVIDER=geoapify` выбирает прежний Geoapify-поиск, а при явном
`SEARCH_PROVIDER=demo` используется синтетическая выборка.

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
`SemanticIntentV2` сохраняет собственную schema `2.2`. Во время миграции
legacy canonical IDs для уже поддерживаемых ниш могут отдельно присутствовать
в `SearchPlan.resolution.selectedConceptIds`; они вычисляются сервером после
Kimi и не передаются модели. `needs_confirmation`
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
сводкой, массивом `leads` и явным `outcome`. Непустой ответ имеет
`success_with_results`, пустая выборка источника — `success_empty` и HTTP 200.
У каждого лида есть массив `sources` с provider ID, внешним ID и временем
наблюдения; дополнительные условия помещения возвращаются в `requirements` со
статусом `confirmed_match`, `confirmed_mismatch`, `unknown` или `conflicting`.
Отсутствие данных не считается совпадением и даёт `unknown`. Неоднозначный
intent возвращает HTTP 409 с `outcome=clarification_required` и
`SEARCH_PLAN_CONFIRMATION_REQUIRED`. Ошибки валидации и инфраструктуры имеют
`outcome=technical_failure`; ошибка live-провайдера не подменяется демоданными.
Однозначный физический intent без локального concept ID не получает
терминальный 422: сервер формирует bounded Geoapify fallback-план.

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

## Live-поиск 2GIS

При `SEARCH_PROVIDER=2gis` LeadRadar отправляет в 2GIS Places API свободный
текст типа бизнеса, координаты центра и радиус. Заранее известный `rubric_id`
не требуется: сервер выполняет до трёх bounded-запросов по основному типу и
синонимам, затем локально дедуплицирует и проверяет evidence релевантности.
В demo-режиме один запрос получает не более 10 карточек, а радиус ограничен
50 км. Пустой ответ источника возвращается как `success_empty`.

2GIS выбран явно и не смешивается с Geoapify в одной выдаче. В текущей alpha
Geoapify Geocoding всё ещё определяет координаты введённого города или адреса;
сам поиск организаций после этого выполняет 2GIS.

Обе встроенные карты работают через 2GIS MapGL: поисковая карта сохраняет
выбор центра, перетаскивание метки и окружность радиуса, а карта результата —
масштабирование по области и кликабельные маркеры лидов. Для production задайте
отдельный `DGIS_MAP_KEY`, ограниченный Map Tiles и разрешёнными доменами. При
пустом `DGIS_MAP_KEY` локальный server-render может использовать
`DGIS_API_KEY`, но этот fallback раскрывает ключ браузеру и предназначен только
для локальной проверки.

Demo-ответы 2GIS имеют policy `contract_required`: интерфейс показывает
атрибуцию, но не сохраняет их в `localStorage` и не разрешает CSV-экспорт.
Наличие API-ключа или личный исследовательский сценарий сами по себе не меняют
эту policy; снять ограничение можно только после подтверждения прав на
хранение, переработку и экспорт. Настройка описана в
[`docs/2gis-setup.md`](docs/2gis-setup.md).

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

Geoapify остаётся отдельным доступным live-провайдером версии
`0.4.0-alpha.1`. Внутри него действует bounded цепочка category Places → Autocomplete для
неизвестной категории → Forward Geocoding по исходному типу бизнеса, если
категория не подтверждена, Autocomplete временно недоступен либо Places не дал
релевантных карточек. Радиус не увеличивается. Timeout, `429` или `5xx`, которые
нельзя безопасно продолжить внутри этой цепочки, возвращаются как ошибка
источника и не маскируются
demo-данными; failover на другой provider не реализован.

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
общий серверный предел — четыре retrieval-запроса и 200 наблюдённых карточек.
Категорийные arms используют Places, а unresolved name-fallback — bounded
Forward Geocoding `type=amenity`; восемь корневых категорий fallback-плана
остаются внутренней provenance/budget границей, а не строкой provider filter.
Исключение — recovery arm из исходного пользовательского запроса: сервер
сверяет его с подписанным preview и допускает Places только после одного
Autocomplete-запроса, подтвердившего allowlisted leaf минимум двумя различными
same-country/in-radius наблюдениями. No-match переводит arm в bounded Forward
Geocoding; подтверждённая широкая категория не считается evidence сама по себе,
а нерелевантная Places-выборка также переводится в текстовый fallback.
Если узкой категории нет, сервер использует фиксированный широкий scope из
registry вместе с ограниченным `name`, а не исполняет категорию из текста
модели. Каждый category ID повторно проверяется перед отправкой провайдеру.
Старый словарь 40 ниш остаётся только fallback обратной совместимости.

Provider compiler принимает только точные нормализованные phrase-совпадения
полного registry; совпавший parent остаётся явно broad, а частичное пересечение
слов не исполняется. Общий суффикс вида `studio`, `clinic` или `shop` удаляется
лишь тогда, когда остаток однозначно указывает на одну точную leaf-category.
Для name-fallback
предпочитается исходная формулировка на языке пользователя; fallback-запрос не
запускается, если предыдущие arms уже дали не менее 10 результатов
`matched + maybe`. Опциональный provider-native hint может уточнить только этот
fallback, не меняет `SemanticIntentV2` или подписанный `SearchPlan`, проходит
повторную проверку по pinned registry и по умолчанию выключен.

Карточки из разных arms дедуплицируются до получения Details и сохраняют все
причины обнаружения. Точные, смежные и fallback-находки различимы в
`SearchPlan.executionPreview.retrievalArms` и `Lead.discovery.retrievalArms`.
Исключения из пользовательского задания и `SemanticIntentV2` применяются по
доступным названию, provider categories и короткому source description до
расхода квоты Details.

Расширяющая provider-category сама по себе считается evidence только при
происхождении из core/precision intent, а не из одного adjacent/recall сигнала.
Таблица и карта по умолчанию показывают рекомендованные `matched + maybe`;
`rejected` и `not_checked` остаются доступны через фильтр и не удаляются.

Open-vocabulary encoder и скомпилированный поиск проверяются versioned live
canary через фактический production-orchestrator. Canary завершён, но Issue #11
quality gate имеет решение `FAIL`: не пройдены fixed-k Precision@10 и целевой
encoder p95. Это не доказательство внешнего SLA. Метрики и границы вывода
зафиксированы в
[`docs/evaluations/v0.4.0-alpha.1-search-live-canary.md`](docs/evaluations/v0.4.0-alpha.1-search-live-canary.md).

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
- Production-orchestrator canary выполнил все 12 сценариев и прошёл
  schema/executability/deadline/safety gates, но не прошёл business-quality
  gate: fixed-k Precision@10 `0.7500` при цели `0.85`. Encoder p95 составил
  29,073 с при цели 20 с. Geoapify-only поиск и внешний SLA имеют решение
  `NO-GO` до улучшения provider grounding/fallback и повторного canary.
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
- [`docs/2gis-setup.md`](docs/2gis-setup.md) — серверный ключ, demo-policy,
  цепочка поиска и короткая проверка 2GIS.
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
- [`docs/evaluations/v0.4.0-alpha.1-search-live-canary.md`](docs/evaluations/v0.4.0-alpha.1-search-live-canary.md)
  — агрегатный production-orchestrator canary с решением `FAIL` по quality gate.
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

- [2GIS Places API](https://docs.2gis.com/en/api/search/places/overview)
- [2GIS Platform Manager pricing](https://docs.2gis.com/en/platform-manager/subscription/pricing)
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
