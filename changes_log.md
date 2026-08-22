# LeadRadar Changes Log

Этот журнал фиксирует существенные изменения продукта, чтобы через несколько
месяцев можно было восстановить не только *что* изменилось, но и *почему*.

Сюда обязательно попадают изменения:

- бизнес-логики и трактовки результатов;
- источников данных и лицензионных ограничений;
- поиска, дедупликации и scoring;
- структуры API и модели данных;
- хранения, экспорта и обогащения лидов;
- безопасности и пользовательского процесса.

Мелкие визуальные правки и рефакторинг без изменения поведения не фиксируются.

## Правила ведения

1. Новая запись сначала добавляется в `Unreleased`.
2. При релизе записи переносятся в раздел версии и получают дату.
3. Опубликованные разделы не переписываются, кроме исправления фактической ошибки.
4. Для изменения бизнес-логики указываются причина, старое и новое поведение,
   затронутые данные, совместимость и способ проверки.
5. `README.md` сохраняет стабильную структуру и меняется только вместе с
   публичным контрактом или номером релиза.
6. Источник номера версии — `package.json`; Git-тег имеет формат `vX.Y.Z`.

## [Unreleased]

### Добавлено

- Исправлена несовместимость UI runtime guard с новым open-world fallback:
  серверный deterministic SearchPlan с локализованными `coreBusinessTypes` и
  `retrievalTerms` (например, русским `Бар`) был исполнимым, но браузер ошибочно
  применял к нему Kimi-only требование английского provider-neutral терма и
  показывал «неподдерживаемый формат ответа». Теперь это требование действует
  только при `resolution.method=kimi`, `ai.used=true` и успешной AI validation;
  остальные structural/state invariants SearchPlan не ослаблены.

- Любой schema-valid, однозначный физический intent теперь получает исполнимый
  Geoapify-план независимо от наличия локального concept ID и confidence band.
  Kimi по-прежнему возвращает только смысл, синонимы и требования, а provider
  IDs, география и retrieval arms вычисляются сервером. Неизвестный тип сначала
  проходит один bounded Autocomplete-запрос; отсутствие надёжной leaf-category
  или recoverable timeout/upstream failure переводит тот же source-derived arm
  в Forward Geocoding `type=amenity` вместо
  терминального `NO_SUPPORTED_CONCEPT`/HTTP 422. Если Autocomplete подтвердил
  широкую категорию, Places-карточки принимаются только при независимом
  текстовом evidence исходного типа; нулевая или нерелевантная выборка также
  запускает Forward Geocoding. Пустой финальный ответ является HTTP 200 с
  `outcome=success_empty`, непустой — `success_with_results`, ambiguity —
  `clarification_required`, а инфраструктурные ошибки — `technical_failure`.
  Условия помещения оцениваются после карточек и без данных получают `unknown`.
  UI показывает Kimi только при `ai.used=true` и `ai.validation=passed`.
  Ручных aliases и нового provider не добавлено. Decision policy повышена до
  `2026-08-22.1`, compiler/runtime policy — до
  `semantic-retrieval-v2/2026-08-22.1`; публичная SearchPlan schema остаётся
  `2.2`, а SearchResponse получил явное поле outcome.

- Production search canary теперь немедленно сводит `plan` из terminal error
  event к bounded диагностике: allowlisted status/reason codes, AI validation,
  latency, usage и version identity. Полный план, пользовательский intent и
  semantic terms после проекции не удерживаются и в отчёт не попадают; JSON
  сохраняет только агрегированные counts финального planner outcome каждого
  кейса; retry-коды и timing всех попыток остаются в отдельной bounded
  диагностике попыток. Неизвестный или дублированный reason code делает
  проекцию `unreported`, а не маскируется фильтрацией. Раньше
  `SEARCH_PLAN_UNSUPPORTED` терял вложенный plan и ошибочно снижал
  `schemaPassRate`, `allCasesUsedKimi` и coverage usage до `unreported`, даже
  если Kimi-ответ прошёл schema и был отклонён только provider-grounding
  policy. Evaluation policy повышена до
  `search-live-canary-v2/2026-08-21.2`; production search behavior не изменён.
  Перед записью отчёта каждый финальный план обязан явно подтвердить ожидаемые
  model/prompt identities; отсутствующее значение больше нельзя скрыть
  фильтрацией `null` среди совпавших кейсов.
  После retry финальный успешный план всегда проецируется самостоятельно:
  невалидный новый контракт не может подмениться диагностикой предыдущей
  неудачной попытки.

- После повторяемого live-промаха `climbing` при корректном общем понимании
  запроса Kimi transport получил отдельный wire-only массив
  `providerNeutralCategoryHeads`. Раньше краткий provider-neutral head был лишь
  необязательной частью богатого `retrievalTerms.precision`, поэтому модель
  могла вернуть понятное описание без единственного слова, которое полный
  provider registry умеет сопоставить. Теперь для однозначного физического
  запроса Kimi обязан вернуть от одного до четырёх английских natural-word
  heads длиной до 64 символов и пяти слов; сервер NFKC-нормализует и
  дедуплицирует их без truncation, добавляет перед обычными precision terms и
  удаляет wire-поле до формирования публичного `SemanticIntentV2 2.2`.
  Ambiguous, `non_physical` и `unclear` ответы обязаны оставлять heads и все
  положительные semantic-массивы пустыми. Semantic auto-run разрешён только
  если хотя бы один проверенный head дал точный leaf/path в полном закреплённом
  Geoapify registry; неизвестный или parent-only head не может быть замаскирован
  общим name-fallback. Dotted/underscored provider syntax, включая ID в скобках
  и иной пунктуации, отклоняется до compiler. Wire precision ограничен восемью
  исходными элементами, heads — четырьмя, а объединённый внутренний precision —
  прежними двенадцатью; raw overflow и exclusions не обрезаются. Короткий
  post-checkpoint live-срез показал две дополнительные системные ошибки K2.6:
  голая поисковая фраза ошибочно считалась неявным non-place запросом, а длинный
  список синонимов переполнял wire precision. Prompt теперь явно считает
  `primaryQuery` уже находящимся в контексте поиска мест, отправляет generic
  place-form nouns на clarification и после сериализованной K2.6 структуры
  повторяет компактный cardinality contract. Следующий aggregate-only K2.6
  срез подтвердил schema-pass `10/10`, но локализовал оставшиеся отказы в
  semantic state и provider grounding. User payload теперь явно несёт
  server-owned `business_place_search` context, а поздняя K2.6 state matrix
  различает unresolved physical purpose (`unclear/required/ambiguous`) и
  настоящий non-place (`non_physical/not_applicable`). Обратный локальный
  инвариант запрещает `not_applicable` для любого другого entity kind.
  Составной provider-neutral head по-прежнему не сокращается эвристически:
  same-root сочетания вроде `cinema gym` или `bank workshop` остаются
  fail-closed, пока wire-контракт не передаст semantic roles отдельно.
  Отдельный role-tagged cue с `essentialCategoryPhrase` и
  `surfaceVenueForm` был проверен на том же frozen K2.6 corpus и отклонён:
  schema-pass снизился с `10/10` до `8/10`, outcome/execution — с `8/10` до
  `5/10`; climbing/pottery остались coverage gaps, а cardiology получил новую
  schema-valid coverage-регрессию. Эксперимент сохранён в Git-истории, но
  рабочий контракт возвращён к массиву heads. Ни provider-specific aliases,
  ни suffix/subphrase guessing по результату не добавлялись; оба live-отчёта
  остаются aggregate-only и gitignored.
  Локальная граница по-прежнему отклоняет девятый precision item вместо
  усечения. Aggregate-only A/B сохраняет
  только allowlisted plan reason-code counts, чтобы отличать non-place от
  provider-coverage отказа без model text. Для дешёвой повторной диагностики
  harness может запускать один строго allowlisted профиль через
  `KIMI_COMPARISON_PROFILE_ID`; такой неполный запуск остаётся `PARTIAL` и не
  может выбрать release-профиль. Изменение
  поднимает Kimi model policy до `2026-08-20.6`, prompt content до
  `2026-08-20.9`, MFJS transport schema до `2026-08-20.5`, provider compiler
  policy остаётся `2026-08-20.6`, а decision policy — `2026-08-20.3`, тем самым
  инвалидируя старые runtime cache/confirmation contexts. В публичный план,
  persistent storage и live aggregate не попадают ни wire field, ни raw
  model/provider responses; production canary теперь отдельно связывает отчёт
  с точной transport-schema version.

- Добавлена versioned server-side политика Kimi для latency-среза Issue #14:
  `kimi-k3` получает только совместимый `reasoning_effort=low|high|max`, а
  `kimi-k2.6` — только `thinking={type:disabled}`. Неизвестная модель,
  несовместимая пара model/effort и несовпадающий model ID в SSE отклоняются до
  использования результата. Runtime cache разделён по точному model-mode-effort
  identity, а эффективная prompt/hash version включает точные model-mode-effort.
  SSE явно запрашивает usage и прекращает чтение сразу после `[DONE]`, включая
  отдельный terminal usage chunk. Opt-in aggregate-only A/B harness сравнивает
  эти два профиля на десяти зафиксированных mixed open-world CIS cases (ready,
  ambiguous, non-place и injection; 60 encoder attempts по умолчанию), считает
  exact outcome/execution-contract, p50/p95 и tokens. Без свежего подходящего
  production journey canary результат остаётся `PARTIAL/NON_BLOCKING`, даже
  если encoder-профиль прошёл; release gate также требует first progress p95
  <=500ms, terminal p95 <=55s и каждую попытку <=60s. Journey report принимается
  только при точном совпадении текущих model/prompt/policy/schema/catalog,
  corpus/rubric и production bundle/harness fingerprints. Production canary
  выбирает только один из двух server-owned профилей (`k3-low` или
  `k2.6-thinking-disabled`), фиксирует фактический plan prompt/cache identity и
  использует закреплённую для профиля цену. Стоимость A/B учитывает reported
  cache hits, а при отсутствующем `cached_tokens` консервативно тарифицирует
  весь prompt как cache miss и отдельно считает неизвестный cached usage.
  Первичный aggregate-only A/B выявил несовместимость сложной Structured Output
  схемы с `kimi-k2.6` и не выбрал профиль; после разделения MFJS transport-схемы
  и строгой локальной валидации одиночный K2.6 JSON-mode pilot прошёл schema gate
  за 15 454 мс. Первый полный A/B на исправленном transport-протоколе также не
  выбрал профиль: K3 прошёл schema gate в 53,33% попыток, K2.6 — в 63,33%; у
  обоих доминировала локальная ошибка размера массивов, а K3 дополнительно
  получил восемь `429` при общем pacing 30 секунд. Диагностика разделена на
  `minItems`/`maxItems` и агрегируется по ID замороженного синтетического кейса
  без текста запроса. `SemanticIntentV2` повышен до `2.2`: корректные
  неоднозначные и `non_physical/not_applicable` ответы могут оставлять core и
  precision пустыми и остаются неисполняемыми, тогда как любой однозначный
  физический запрос по-прежнему обязан иметь core, precision и английский
  retrieval term. Перед строгой проверкой модельные массивы только NFKC-
  нормализуются и дедуплицируются; переполнение, особенно исключений, не
  обрезается и отклоняется fail-closed. Planner повторно валидирует результат
  любого encoder-adapter. Повторный A/B использует отдельный от production
  scheduler pacing: минимум 35 секунд глобально и 70 секунд для той же модели,
  без retry/backfill. Повторный диагностический срез на 20 попыток подтвердил,
  что `array_min_size` и `429` устранены: K3 прошёл schema gate в 90%, K2.6 —
  в 80%, но ни один профиль пока не выбран. Остались единичные malformed/oversize
  ответы, один `maxItems` у неоднозначного запроса и provider-compilation misses.
  Prompt теперь явно ограничивает размер каждого массива и классифицирует
  информационные/советующие запросы без физического места как `non_physical`;
  wire/content size и конкретное переполненное поле имеют отдельные безопасные
  reason codes. A/B сохраняет только allowlisted actual status и скомпилированные
  provider-категории по frozen case ID. Финальный полный A/B остаётся
  обязательным перед production canary и закрытием Issue #14.

- Добавлен opt-in production search canary через фактический NDJSON-orchestrator
  с реальными Kimi и Geoapify и консервативной ручной оценкой относительно
  literal baseline. Набор покрывает 12 сценариев, пять городов, три страны,
  десять новых для legacy taxonomy типов и два mixed-language случая. В
  versioned отчёт попадают только агрегаты, версии и checksum; запросы,
  карточки, контакты, raw provider/model responses и ключи не сохраняются.
  Fixed-k Precision@10 считает десять позиций на каждый запрос, provider
  identities связываются между запросами только session-salted HMAC в памяти,
  а deadline и p95 учитывают каждую попытку и полный retry journey.
  Evaluation policy, набор кейсов, rubric, runtime profile, production bundle и
  сам canary harness имеют отдельные версии/checksum. Перед запуском worker
  собирается без Kimi key, затем secret wrapper включает ровно ключ из
  отдельного secret-файла и восстанавливает обе совместимые env-переменные даже
  при ошибке secret-scan. Временный provider-fact observer доступен только по
  случайному canary-каналу, работает после bounded parse и сверяет все
  показанные названия, адреса, координаты, категории, контакты, сайты и соцсети
  без записи raw response или карточек на диск.

- Production search canary теперь одной transient-разметкой оценивает не
  только frozen top-10, но и уже возвращённый production candidate pool — до
  50 дедуплицированных карточек на кейс. Top-10 labels выводятся сервером из
  тех же 1-based ranks; дубли, неполная разметка и pool overflow отклоняются
  fail-closed. Отчёт с evaluation policy `2026-08-21.1` считает
  `attainable@10 = sum(min(10, relevant in pool)) / 120` и conditional ranker
  recall, но не меняет прежние hard gates, fixed-k Precision@10 или итоговый
  verdict Issue #11. Это decision-support ceiling только для фактически
  выполненных retrieval arms, а не полный recall Geoapify или рынка: значение
  ниже `0.95` запрещает ranker-only tuning, но само по себе не доказывает
  необходимость конкретного второго источника. Измерение добавляет ноль
  provider requests/cards/details; provider budgets и наблюдённые counters
  записываются только числами. Provider metadata отдельно сообщает planned и
  completed arms, связывает runtime-refined fallback с исходным signed-plan arm
  и считает общий request budget как retrieval + Details + category resolution;
  effective arm IDs проверяются только transient и в aggregate не попадают.
  Candidate ranks, session-salted identities и карточки остаются в памяти,
  manual review получает 45 минут, а новый attainable policy входит в version
  identity production/A-B gate. Сохранённый aggregate и финальная console-
  сводка теперь классифицируют measured gap как невалидное измерение,
  retrieval/source gap, ranking/fusion gap или уже достигнутый порог fixed-k
  Precision@10. Низкий executed-arm ceiling прекращает ranker-only tuning, но
  не объявляет конкретный второй источник обязательным без отдельного полного
  Geoapify ceiling и письменного license-решения. Развилка использует сырые
  aggregate counts до округления и не добавляет нового hard gate.

- Добавлен frozen deterministic relevance gate на 600 явно размеченных
  синтетических `CandidateEvidence` по 150 различным provider-категориям: по
  150 `matched`, `maybe`, `rejected`, `not_checked` и по 15 prompt-injection
  случаев в каждом статусе. Retrieval-контекст, evidence и label фиксируются
  независимо, а precision/broad/empty/conflict сценарии пересекают статусы.
  `npm run eval:relevance` измеряет matched
  precision/recall, positive-to-rejected, точность evidence references,
  обязательную evidence-поддержку, identity и fail-closed обработку
  невалидного classifier output. Контракт `2026-08-17.2` принимает только
  точную схему результата/evidence и совместимый со статусом machine reason
  code, поэтому дополнительные поля или произвольный текст не попадают в лид.
  Отчёт содержит только агрегаты, версии и checksum. Optional Kimi-classifier
  остаётся выключенным по data-flow/rate gate, поэтому его AI-метрики честно
  отмечены `N/A`, а обязательные deterministic safety gates выполняются.

- Добавлен замороженный open-world quality gate для semantic intent: 500
  пользовательских CIS-сценариев, 150 непересекающихся семейств и 100 типов
  физических организаций с family-level split `60/20/20`. Корпус включает
  400 RU, 50 BY и 50 KZ сценариев, 20 mixed-language, 20 неоднозначных, 15
  non-place и 15 injection случаев; 450 физических примеров не входят в
  прежние ручные concept bindings. Две независимые слепые разметки хранят
  только ID и outcome, дают Cohen's kappa `1.0`; checksum развёрнутого корпуса
  фиксирован. `npm run eval:open-world` проверяет реальный planner/compiler с
  mock Kimi, provider executability, false unsupported, безопасность
  open-vocabulary запроса, владение географией и versioned cache. Отчёт содержит
  только агрегаты и завершает процесс с ненулевым кодом при нарушении gate.
  Двадцать hidden-семейств имеют по четыре независимых semantic-описания без
  token overlap с provider ID: успешность обеспечивается общей bounded
  compilation/name-fallback стратегией, а не точечным alias или binding.
  Novelty считается против замороженного baseline
  `canonical-taxonomy-2026-08-16.1`, поэтому будущие bindings не меняют
  исторические метрики корпуса. Все 80 holdout-вариантов обязаны пройти
  grounded provider compilation; порог этой части равен 100%, поэтому
  единичный alias не закрывает family-level failure.

- Добавлен локальный Docker runtime с multi-stage production-сборкой и тем же
  адресом `127.0.0.1:3000`. Контейнер получает ключи только при запуске из
  исключённых из Git env-файлов; секреты и локальные результаты не входят в
  build context или образ. Для снижения нагрузки установлены лимиты `0,5 CPU`,
  `256 МБ` памяти, `160 МБ` Node.js heap и `64` процесса, read-only rootfs,
  непривилегированный пользователь и запрет Linux capabilities. Это меняет
  только способ локальной эксплуатации и не меняет поиск или API-контракт.

- Блок «Где ищем» стал полноценным переключателем пяти режимов в порядке
  `Город → Район → Метро → Область → Радиус`. Каждый режим меняет подписи,
  подсказки и рекомендуемый круговой охват; ручной клик по карте переводит
  задание в режим «Радиус», чтобы интерфейс не выдавал произвольную точку за
  выбранный город, район или станцию.
- Добавлен поиск вокруг конкретной станции метро. Пользователь сначала выбирает
  один из семи действующих метрополитенов России, затем ищет станцию по названию
  и задаёт радиус от 0,5 до 10 км; стартовое значение — 1,5 км. Выбор станции
  автоматически переносит центр карты на её координаты.
- Новый server-side `GET /api/metro-stations?city=<id>&q=<optional>` получает
  нормализованный справочник через Geoapify Places
  (`public_transport.subway`), объединяет одноимённые пересадочные записи и
  сохраняет line colors/place IDs. Если введённой станции нет в каталоге,
  выполняется точный Geocoding fallback с повторной проверкой Place Details.
  API-ключ и полные upstream-ответы клиенту не передаются и не сохраняются.
  Каталог кэшируется 24 часа со stale-on-error; fallback ограничен тремя
  кандидатами, клиентским и глобальным rate limit и общим deadline 30 секунд.

### Бизнес-логика и ограничения

- Open Kimi boundary сохранён: модель по-прежнему возвращает только bounded
  provider-neutral `SemanticIntentV2` и не получает pinned registry, его
  категории или provider-native hints. Full registry, bounded compilation до
  четырёх arms/upstream retrieval-запросов и вся executable policy остаются
  server-owned и повторно валидируются перед Geoapify.
- Geoapify compiler больше не принимает частичное пересечение слов как
  категорийное совпадение: требуется exact normalized phrase; совпавший parent
  остаётся явно broad. Общие бизнес-суффиксы удаляются как fallback только при
  единственной точной leaf-category; неоднозначный остаток не компилируется.
  Name-fallback теперь предпочитает
  исходный primary/related query на языке пользователя и выполняется только
  пока предыдущие arms дали меньше 10 результатов `matched + maybe`.
- Source-language fallback больше не выбирает фразу только по минимальной
  длине: содержательный primary из не более трёх слов имеет приоритет, а для
  длинной формулировки related-варианты сортируются детерминированно. Поэтому
  «музыкальная школа», «студия загара солярий» и «книжный магазин» не уступают
  более короткому, но менее полному запросу; порядок relatedQueries не влияет
  на план.
- Английские retail-формы `bookstore`, `book store`, `bookshop`, `book shop`
  разбираются общей суффиксной политикой и сужаются до единственного leaf
  `commercial.books`. Контекст `store/shop` не разрешает выбирать одноимённый
  leaf из другой ветки, а неоднозначные `petstore` и product-only запросы не
  получают случайную категорию. Compiler policy повышена до
  `semantic-retrieval-v2/2026-08-20.4`.
- Добавлен default-off `GEOAPIFY_CATEGORY_HINTS_ENABLED`. При явном включении
  Geoapify Autocomplete `features[].properties.category` может ограниченно уточнить только
  внутренний name-fallback arm. Сервер принимает не более двух уникальных leaf
  IDs полного pinned registry, применяет exclusions и никогда не изменяет
  исходный `SemanticIntentV2`, подписанный `SearchPlan` или локальную relevance-
  истину. Неизвестный, широкий, пустой или недоступный hint безопасно оставляет
  прежний план без изменения.
- Expansion-only provider evidence теперь повышает relevance только при
  происхождении из core/precision intent; adjacent/recall категория без
  независимого подтверждения не выдаётся за точное совпадение. UI по умолчанию
  показывает рекомендованные `matched + maybe`, сохраняя доступ к `rejected` и
  `not_checked` через фильтр.
- Failed Kimi plans и infrastructure failures больше не попадают в runtime plan
  cache. Cache keys, semantic alternative hashes, confirmation context и plan
  hashes теперь включают compiler policy, версию и checksum provider registry,
  поэтому изменение executable policy не переиспользует старый план.
- Source-language name fallback отсекает prompt-control suffixes до compilation:
  URL, provider instructions и инъекции из нормализованного пользовательского
  запроса не попадают в executable name query или retrieval provenance.
- Внутренняя schema `SemanticIntentV2` повышена с `2.0` до `2.1` после
  backward-compatible ослабления `retrievalTerms.recall`; confirmation context,
  runtime guards, corpus checksum и canary version identity синхронизированы.

- Broad provider category больше не считается одновременно категорией и
  независимым текстовым доказательством. Статус повышается с `maybe` до
  `matched` только при отдельном совпадении в названии/описании либо двух
  независимых текстовых полях; это устраняет ложное уверенное совпадение вроде
  прачечной для общего запроса клининга и не расходует Details на
  недоказанную карточку.

- Поиск получил единый local Tier-0 runtime deadline 60 секунд от admission до
  terminal outcome. Один `AbortSignal` отменяет Kimi SSE, Geoapify/Yandex
  fetch, pacing waits, optional classifier и Details enrichment. JSON при
  исчерпании времени возвращает контролируемый HTTP 504
  `SEARCH_DEADLINE_EXCEEDED`, NDJSON — ровно одну terminal-строку; heartbeat
  поддерживает интервал progress не более 2 секунд. Все stage timeout
  ограничиваются остатком общего бюджета, а пропущенные optional classifier и
  Details отражаются в `provider.coverage.degradedStages`, не выдавая
  `not_checked` за отсутствие контактов.
- Kimi защищён in-process Tier-0 scheduler: один активный вызов, один ожидающий,
  admission timeout 20 секунд и минимальный интервал стартов 20 секунд.
  Переполнение/истечение очереди даёт retryable planner failure
  `KIMI_ADMISSION_TIMEOUT`, а не semantic unsupported. Circuit breaker
  открывается после трёх transient failures за 60 секунд и хранит только
  агрегированные admission/cache counters без ключей, prompt или lead payload.

- После дедупликации и до Geoapify Details добавлена доказательная проверка
  релевантности карточки исходному `SemanticIntentV2`. API и UI используют один
  контракт `matched`, `maybe`, `rejected`, `not_checked`; доказательства могут
  ссылаться только на фактически полученные `name`, provider categories,
  locality и короткое source description. Исключения дают объяснимый
  `rejected`, но карточка остаётся в результате и доступна отдельным фильтром и
  счётчиком. Details расходуются только на `matched/maybe`, а opportunity score
  остаётся отдельной коммерческой оценкой и не подменяет relevance.
- Добавлен feature-flagged seam optional relevance-classifier с максимум 20
  минимизированными `CandidateEvidence`, 32 уникальными provider categories на
  кандидата, opaque session ID и deadline 8 секунд. По умолчанию он выключен и
  реальные карточки Kimi не получает; отсутствие, timeout, oversized/duplicate
  output или невалидная evidence-ссылка дают `not_checked` и `degraded`
  metadata без удаления лида. Демо и отключённый Yandex также явно возвращают
  `not_checked`. Кликабельные URL сайтов и трёхсоставной website status не
  изменены.

- Семантический план обобщён до bounded retrieval arms: precision, recall,
  adjacent и server-owned name fallback. Каждый arm имеет стабильный ID,
  приоритет, происхождение из `SemanticIntentV2` и отдельный result budget;
  независимо от вывода модели сервер допускает не более 4 arms, 4 upstream
  retrieval-запросов, 200 полученных карточек и 50 Details. Категория или
  filter из текста модели по-прежнему никогда не исполняются напрямую.
- Понятный физический запрос без узкой категории теперь пробует ограниченный
  поиск по названию до `PROVIDER_COVERAGE_GAP`: unresolved fallback использует
  bounded Forward Geocoding `type=amenity`, а подтверждённый provider-native
  leaf — Places. Восемь корней остаются внутренней provenance/budget границей
  и не отправляются как category filter. Это позволяет компилировать запросы
  «где занимаются кроссфитом», «студия звукозаписи», «питомник растений» и
  «прокат строительного инструмента» без ручных segment bindings.
- Одинаковая организация, найденная несколькими arms, объединяется до Details
  по provider external ID либо по нормализованной паре «имя + адрес» только
  для точек не дальше 100 метров друг от друга. Это не даёт склеить удалённые
  одноимённые организации с грубым адресом. В результате сохраняются все
  primary/adjacent/fallback причины обнаружения; пользовательские и semantic
  exclusions проверяются по названию, provider categories и короткому source
  description до расхода Details-квоты.
- Если Geoapify Place Details возвращает канонический provider ID, отличный от
  ID исходной Places-карточки, оба значения сохраняются в `Lead.sources`. Это
  удерживает контакты и сайт связанными с наблюдаемой организацией и позволяет
  transient canary доказать происхождение обогащённых полей без ложной ошибки.
- `SearchPlan.executionPreview` и `Lead.discovery` получили retrieval-arm
  metadata, а provider coverage — число arms, upstream requests и принятых
  уникальных карточек. UI показывает виды стратегий и их максимальные бюджеты.
- Публичная схема `SearchPlan` повышена с `2.0` до `2.1`, потому что
  `executionPreview.retrievalArms` и provenance стали обязательной частью
  исполняемого плана. Клиент отклоняет старый или частичный plan payload до
  отображения; внутренняя `SemanticIntentV2` версионируется независимо и в
  текущем дереве имеет schema `2.1`.
- Неоднозначность переведена с canonical concept IDs на semantic alternatives.
  Каждый вариант содержит понятное объяснение, собственный `SemanticIntentV2`,
  opaque ID/hash и отличающийся retrieval preview. HMAC token V2 подписывает
  исходные request/plan hash, список разрешённых alternative hash, версии
  SearchPlan/SemanticIntent/provider/policy/prompt и TTL; выбранный intent
  повторно валидируется и хэшируется до provider call. V1 token не исполняется,
  а клиенту предлагается безопасно перепланировать запрос.
- Из-за несовместимого confirmation-контракта публичная схема `SearchPlan`
  повышена с `2.1` до `2.2`. UI использует нативную radio-группу с клавиатурным
  выбором и показывает объяснение и бюджеты стратегий каждого варианта.

- Добавлен полный versioned capability registry Geoapify: 813 category IDs,
  извлечённых из официального раздела Supported categories 17.08.2026, с
  SHA-256 checksum. Прежние 43 IDs/40 bindings остаются только legacy fallback,
  а не допустимой вселенной поиска.
- Новый deterministic compiler сопоставляет открытые provider-neutral terms из
  `SemanticIntentV2` полному registry, формирует bounded precision и broad
  batches с provenance и повторно проверяет version, checksum и каждый category
  ID перед upstream-вызовом. Прямые model-authored category IDs дополнительно
  запрещены semantic validator.
- «Спортивный зал» теперь получает ready provider plan с категориями
  `sport.sports_hall`, `sport.fitness.gym` и родственными fitness capabilities,
  не выбирает ресторан и не требует canonical concept. Ранее поддерживаемые
  запросы продолжают использовать semantic compiler либо legacy fallback.

- Kimi переведён с выбора одного canonical ID из закрытого списка на
  open-vocabulary `SemanticIntentV2`. Модель теперь систематизирует обычный
  пользовательский запрос в нормализованную цель, отрасли, основные, смежные и
  исключаемые типы бизнеса, услуги, include/exclude signals и precision/recall
  terms. Это устраняет ложный отказ на этапе понимания для новых ниш вроде
  «спортивный зал»; старые canonical IDs не входят в фактический Kimi request.
- В `SearchPlan` добавлен `SemanticIntentV2` со schema `2.0`, раздельная
  уверенность в понимании запроса и покрытии источника, версии prompt/schema,
  usage, latency и hash. UI показывает смысловую трактовку до поиска. Пока
  полный capability compiler не реализован, незнакомая старому серверному
  словарю ниша получает честный `PROVIDER_COVERAGE_GAP`: запрос понят, но
  provider strategy ещё не собрана.
- Structured Output ограничивает длину и число всех бизнес-терминов, общий
  размер JSON и запрещает дополнительные поля. Локальная проверка отклоняет
  противоречивую неоднозначность, URL, координаты и HTTP/provider-параметры;
  такие ответы, как оборванный SSE или отсутствие `[DONE]`, возвращаются как
  контролируемая retryable ошибка. Locale, страна и география остаются
  server-owned.

- JSON и NDJSON теперь запускают одну и ту же search orchestration. Активный
  источник выбирается до provider-specific compilation: demo и Yandex больше не
  проходят через Geoapify category compiler и не показывают ложный этап
  компиляции Geoapify-категорий. Результаты, статусы и provider policies
  сохранены; изменение проверяется общим публичным `/api/search` regression-
  тестом.
- Поддержаны Москва, Санкт-Петербург, Новосибирск, Нижний Новгород, Самара,
  Екатеринбург и Казань. Это обнаруженный справочник Geoapify/OpenStreetMap, а
  не официальный полный реестр: временно закрытые или иначе размеченные станции
  могут отсутствовать. Свободный ввод с fallback снижает этот разрыв, но не
  превращает источник в нормативный каталог.
- Старые payload без `locationMode` остаются совместимыми и трактуются как
  `radius`. Для нового режима `metro` сервер требует одновременно допустимый
  metro system ID, provider ID и название станции, координаты в области системы,
  RU/ru-RU и радиус 0,5–10 км; неполный или противоречивый выбор отклоняется до
  обращения к поисковому провайдеру. При запуске provider ID, название и
  координаты повторно сверяются через Place Details; поиск использует
  канонические координаты подтверждённой станции, а не клиентское утверждение.

### Проверено

- 20.08.2026 повторный фактический production-orchestrator canary получил
  честное решение `FAIL`: schema pass и executable plan rate — `1.0000`,
  safety/provenance violations — `0`, но fixed-k Precision@10 `0.7500` не
  достиг порога `0.85`. Консервативная ручная оценка 116 semantic и 46 literal
  candidates нашла 90 уникальных релевантных организаций против 44, gain
  `1.0455` и precision delta `+0.3833`; рост полноты не отменяет шум и пустые
  позиции верхней выдачи. First progress p95 — 83 мс, terminal и semantic
  journey p95 — 35 539 мс; все 12 attempts завершились с первой попытки и
  уложились в per-request deadline 60 с. Encoder p95 — 29 073 мс и также не
  прошёл цель 20 с. Usage всех вызовов — 11 346 input / 6 683 output tokens;
  стоимость `$0.134283` не содержит неоценённого failed attempt.
  Provider-native resolution выполнил три запроса: `not_needed=9`,
  `no_match=1`, `degraded=0`, `resolved=2`; feature flag
  остаётся выключенным. Issue #11, Issue #12 и release остаются
  заблокированными. Полный агрегатный отчёт:
  [`docs/evaluations/v0.4.0-alpha.1-search-live-canary.md`](docs/evaluations/v0.4.0-alpha.1-search-live-canary.md).

- Semantic confirmation проверен transient-вызовами реального `kimi-k3` для
  запроса «склад»: финальный planner-вызов за 26,7 с вернул
  `needs_confirmation`, strict schema validation `passed` и две независимо
  скомпилированные alternative — «Складские услуги» и «Фулфилмент». Из трёх
  последовательных canary-вызовов два прошли, один завершился контролируемой
  validation failure; это подтверждает функциональный путь, но не внешний SLA.
  Ключ, raw model response, reasoning и lead data не сохранялись.
- Регрессионные тесты подтверждают, что ambiguous plan, испорченный или V1
  confirmation token отклоняются до provider-backed проверки географии и до
  любого Places-запроса; корректно подписанная alternative исполняет именно её
  retrieval preview.
- Два opt-in live smoke на реальных `kimi-k3` и Geoapify прошли за 27,4–27,7 с:
  `SemanticIntentV2` schema validation — passed, provider plan — ready, найдено
  3–20 карточек спортивных организаций, Place Details — 3 из 3 в обоих
  запусках. Ключи, raw provider responses и lead data не сохранялись. Один
  предыдущий запуск вернул
  контролируемый retryable `SEARCH_PLANNER_UNAVAILABLE`, поэтому единичный PASS
  не считается доказательством внешнего SLA.

- Новый encoder проверен реальным `kimi-k3` на трёх обычных формулировках из
  разных ниш. Барбершоп прошёл strict schema за 13,8 с; «Спортивный зал» за
  24,9 с выделил спортзал, тренажёрный зал и фитнес-клуб, смежные форматы и
  исключение магазинов; «Ремонт телефонов» за 30,3 с выделил сервисные точки,
  ремонт экранов и исключил розничную продажу. Два промежуточных вызова
  достигли действующего 30-секундного timeout и корректно вернулись как
  retryable infrastructure failure. Поэтому фактический SLA/deadline будет
  калиброваться отдельно в Issue #8; единичные canary не считаются доказанным
  p95. Ключ, raw ответы и пользовательские данные не сохранены.

### Исправлено

- Неоднозначный план с вариантами, но без настроенного
  `SEARCH_PLAN_SIGNING_SECRET`, больше не возвращается как якобы рабочий
  HTTP 200: это retryable `SEARCH_PLANNER_UNAVAILABLE`/503, а карта не
  вызывается. Скрытые нативные radio-переключатели semantic alternatives
  получили видимый `focus-within` outline для клавиатурной навигации.
- Асинхронные ответы геокодера и уточняющего поиска станции больше не могут
  вернуть форму в старый город или режим после действий пользователя. Запросы
  отменяются при изменении ввода, а неоднозначное совпадение теперь требует
  явного выбора из нескольких станций вместо автоматического выбора первой.
- На экранах 320–430 px пять режимов географии сжимаются внутри панели без
  горизонтального переполнения; «Радиус» остаётся видимым последним справа.
- Карта результатов больше не падает при первом переключении из таблицы.
  Причиной был вызов `Leaflet.Circle.getBounds()` у временного круга до его
  добавления на карту: внутри Leaflet ещё отсутствовала ссылка на map instance.
  Viewport выбранного радиуса теперь рассчитывается через независимый
  `LatLng.toBounds()`, без создания detached layer. Добавлены исходный
  регрессионный тест и повторная браузерная проверка перехода «Таблица → Карта».

## [0.4.0-alpha.1] — 2026-08-16

### Что теперь может пользователь

- Свободное описание бизнеса сначала переводится в независимое canonical
  понятие и проверяемый `SearchPlan`, а уже затем в категории Geoapify. Это
  заменяет прежний UX, где незнакомая формулировка сразу завершалась ошибкой
  «категория не настроена».
- Перед расходом квоты карт интерфейс показывает, как понял запрос: выбранную
  категорию, способ трактовки, уверенность и альтернативы. Однозначный запрос
  запускается автоматически, а неоднозначный ждёт подтверждения пользователя.
- Добавлена таксономия из 40 типов физического бизнеса для RU и пилотных
  сценариев BY/KZ. Формулировки вроде «барбершоп», «аптека» и «автомойка»
  проверены на реальном Kimi API; общий термин «склад» не запускает Geoapify до
  выбора трактовки.
- Процесс поиска показывает новые этапы понимания намерения и компиляции
  безопасного provider-запроса. Сайты в разрешённых результатах остаются
  кликабельными.

### Бизнес-логика и границы AI

- Kimi используется как open-vocabulary semantic encoder. Он не получает
  candidate taxonomy и не является источником организаций, контактов или
  provider parameters: модель возвращает только bounded `SemanticIntentV2`, а
  URL, координаты, filter и model-authored category ID отклоняются локально.
- Provider selectors компилируются детерминированным серверным кодом из
  provider-neutral retrieval terms против полного pinned registry. Raw output
  модели не попадает в URL Geoapify.
- Для неоднозначности используется stateless HMAC-token V2 с TTL. Он связывает
  исходные request/plan hashes, полные хэши разрешённых semantic alternatives и
  версии schema/compiler/provider/policy; изменённый, устаревший или не
  предложенный intent подтвердить нельзя.
- Kimi-классификация найденных карточек намеренно не включена. Реальные лиды,
  телефоны, email, сайты и полные адреса модели не передаются до отдельного
  data-flow и лицензионного решения. Runtime deterministic relevance работает
  локально на разрешённых evidence fields; optional Kimi seam остаётся off.

### API и совместимость

- Добавлен `POST /api/search/plan`, возвращающий `ready`,
  `needs_confirmation`, `unsupported` или безопасный `degraded` план без вызова
  Geoapify.
- `POST /api/search` и потоковый `POST /api/search?stream=1` сохраняют прежние
  top-level поля. Вход обратно совместимо расширен `locale`, `countryCodes`,
  `confirmedConceptIds` и `confirmationToken`; успешный ответ может содержать
  `plan`.
- NDJSON получил этапы `intent_resolution` и `provider_compilation`.
  Неоднозначность возвращает HTTP 409, неподдерживаемый intent — HTTP 422; оба
  ответа содержат структурированный код и безопасный план без карточек.
- Сбой Kimi (timeout, `429`, `5xx`, ошибка авторизации или невалидный ответ)
  больше не выдаётся за неподдерживаемую бизнес-категорию: при отсутствии
  безопасной локальной трактовки `/api/search/plan` и обычный `/api/search`
  возвращают retryable HTTP 503 с кодом `SEARCH_PLANNER_UNAVAILABLE`; интерфейс
  показывает повторяемую ошибку и не подменяет её карточкой «ниша не
  поддерживается».
- Несовместимая пара `locale`/`countryCodes` теперь отклоняется как HTTP 400 до
  запуска планировщика; например, `ru-RU` нельзя отправить вместе с `KZ`.
- Kimi transport работает через входящий SSE `stream=true`, принимает только
  `delta.content`, требует terminal `finish_reason=stop` и `[DONE]`, после чего
  выполняет локальную AJV-проверку. Оборванный или лишний поток отклоняется
  целиком.

### Безопасность и эксплуатация

- Kimi-ключ читается только server-side из `MOONSHOT_API_KEY` или
  `KIMI_API_KEY`. Добавлен PowerShell wrapper
  `scripts/run-with-kimi-secret.ps1`, который читает ключ из внешнего
  `~/.sa-trainer-secrets/kimi.env`, создаёт временный signing secret и не
  копирует значение в репозиторий.
- Kimi base URL ограничен официальными HTTPS-hosts Moonshot; ошибки не содержат
  Authorization header, prompt, reasoning или raw response.
- В Kimi planner отправляется только пользовательское описание категории без
  taxonomy/candidate list. Данные найденных компаний planner не получает;
  optional post-search seam выключен и ограничен минимальным
  `CandidateEvidence` отдельным feature flag.
- Значение `temperature=0` удалено после реального HTTP 400 от `kimi-k3`: модель
  принимает свой поддерживаемый default. На это добавлен регрессионный тест.

### Проверка alpha

- Offline golden evaluation: 222/222 planner cases, 30 протестированных concept
  families при 40 элементах taxonomy,
  30 zero-token-overlap cases и 60 synthetic classifier fixtures; Top-1,
  macro-F1, auto-resolution precision, semantic recall и hash stability равны
  `1.0000`, hard violations — `0`.
- Финальный реальный Kimi canary на `kimi-k3` прошёл 5/5 сценариев: обычные
  запросы RU/BY/KZ, неоднозначный «склад» и неподдерживаемая облачная CRM.
  Strict schema прошла 5/5; API latency p50 — 3,798 с, p95 — 4,695 с. Пять
  вызовов использовали 15 399 input и 355 output tokens; оценочная стоимость
  при тарифах $3/$15 за миллион токенов составила $0,051522.
- Полный live-путь Kimi → compiled Geoapify → NDJSON проверен для барбершопа в
  Москве: 100 карточек источника, 95 нормализованных лидов, 18 сайтов и
  16 телефонов; raw responses не сохранялись.
- Реальный неоднозначный запрос «склад» остановился до provider, выдал два
  варианта и подписанный token. После подтверждения `logistics.warehouse`
  поиск успешно вернул 2 лида.
- Fault suite покрывает 401, 429, 5xx, timeout/abort, malformed и оборванный SSE,
  отсутствие `[DONE]`, неверный finish reason, лишние поля, исполняемые строки
  и model-authored provider category IDs.

### Почему это alpha, а не production

- Frozen evaluation пока содержит 222 planner и 60 classifier примеров против
  release-gate 500/600; live canary из нескольких запросов не доказывает p95 или
  внешний SLA.
- Три обычных live cases использовали 3210–4127 input tokens, то есть целевой
  лимит `≤ 3000` не пройден. Измеренная оценочная стоимость полного набора из
  пяти canary-вызовов — $0,051522. Token gate остаётся отдельным NO-GO до
  оптимизации prompt и повторного измерения.
- Не реализованы production scheduler, admission limiter, circuit breaker,
  auth/multi-tenancy и постоянная telemetry. Текущий in-process cache ограничен
  200 планами и TTL 10 минут.
- Geoapify остаётся единственным live-провайдером. Provider adapter принимает
  скомпилированные категории, но полный двухфазный вынос geocoding,
  exclusions/dedupe и Details в отдельный search service ещё не завершён.
- Целевой local SLO остаётся внутренней гипотезой: известная категория обычно
  до 15 секунд, AI-assisted поиск — до минуты. Публиковать договорный SLA можно
  только после минимум 10 000 репрезентативных jobs за 28 дней и перехода на
  production-tier инфраструктуру.

## [0.3.1] — 2026-08-16

### Исправлено

- Карта выбора области больше не растягивает правую колонку до высоты всей
  формы: высота зафиксирована на 280 px для desktop и 230 px для мобильного
  экрана. Причиной был конфликт `height: 100%` в CSS-модуле с ограничением
  высоты в общем stylesheet; более поздний CSS-модуль выигрывал каскад.
- Добавлен регрессионный тест, который запрещает возвращать `height: 100%` в
  корневой контейнер поисковой карты и фиксирует оба responsive-размера.

## [0.3.0] — 2026-08-16

### Добавлено

- Интерактивная карта OpenStreetMap в поисковом задании: центр можно выбрать
  кликом по карте или перетаскиванием маркера, а круг показывает фактический
  радиус будущего запроса.
- Серверный `POST /api/geocode` для переноса введённого города, района или
  адреса на карту без передачи ключа Geoapify в браузер.
- Необязательное поле `center` в поисковом задании в порядке
  `[долгота, широта]`.
- Потоковый `POST /api/search?stream=1` с NDJSON-событиями этапов поиска и
  итоговой записью результата или ошибки.
- Живой индикатор этапов: валидация, определение центра, поиск организаций,
  получение контактов, подготовка выборки и завершение.
- Кликабельные безопасные HTTP(S)-ссылки на сайты в таблице результатов.
- Предсказуемый старт карты результатов: выбранный центр поиска либо Москва,
  если пользователь ещё не фиксировал другую точку.

### Бизнес-логика

Причина: текстовый адрес не давал пользователю проверить, какую именно точку
геокодер выбрал центром, а длительный live-запрос выглядел зависшим до получения
всего ответа. Пользователь также видел статус сайта, но не мог перейти на него
прямо из таблицы.

Новое поведение:

- пользователь может сначала определить центр по текстовому адресу, а затем
  скорректировать его непосредственно на карте;
- если передан `center`, выбранные координаты имеют приоритет и повторное
  геокодирование перед поиском не выполняется;
- изменение радиуса сразу обновляет видимую область поиска;
- карта результатов больше не строит стартовый viewport по случайному выбросу
  координат: она открывает область заданного центра и радиуса;
- интерфейс показывает фактическое движение запроса по этапам и количество
  обработанных запросов или карточек там, где провайдер сообщает прогресс;
- готовые результаты по-прежнему появляются только после нормализации всей
  выборки, поэтому промежуточные карточки не принимаются за окончательный
  список;
- ссылка на сайт отображается только для URL, который прошёл серверную
  нормализацию как HTTP(S); отсутствие URL сохраняет прежнюю осторожную
  трактовку «не указан в полученных данных».

### API и совместимость

- Обычный `POST /api/search` сохраняет JSON-ответ и прежний обязательный
  контракт: существующим клиентам не требуется переходить на streaming.
- `center` добавлен обратно совместимо и проверяется на допустимые диапазоны
  долготы и широты; текстовый `location` остаётся рабочим способом задать
  географию.
- При `?stream=1` сервер возвращает `application/x-ndjson`. События прогресса
  имеют тип `progress`, этап, статус, сообщение, время и при наличии счётчики;
  финальная строка имеет тип `result` или `error`.
- Ошибочный JSON и некорректный `center` в потоковом режиме возвращают HTTP 400
  с одной NDJSON-записью ошибки; ошибки live-провайдера не подменяются demo.
- `POST /api/geocode` возвращает координаты, очищенный от крайних пробелов
  исходный `location` и ID провайдера; отсутствие серверного ключа сообщает
  HTTP 503.

### Источники и безопасность

- Поисковая карта использует OpenStreetMap с обязательной атрибуцией.
- Geoapify остаётся единственным live-провайдером; fallback и aggregation в
  этом релизе не добавлены.
- API-ключ остаётся только в server-side env и не входит в progress-события,
  ответы ошибок или клиентский код.
- URL сайтов от каждого провайдера допускаются в интерфейс только после
  нормализации и проверки протокола HTTP(S).
- Потоковые ответы запрещают кэширование; raw-ответы Geoapify по-прежнему не
  сохраняются.

### Проверка

- Автотест покрывает NDJSON-последовательность от `validation` до `complete` и
  наличие итоговой записи `result`.
- Проверено, что переданный центр карты исключает дополнительный upstream
  geocoding-запрос и сохраняется в нормализованном задании.
- Автотест проверяет HTTP 400 и структурированную NDJSON-ошибку для координат
  вне допустимого диапазона.
- Mock-тест `POST /api/geocode` проверяет server-side geocoding, формат
  `[долгота, широта]` и отсутствие ключа в ответе.
- Отдельный тест проверяет, что небезопасная схема сайта из адаптера Яндекса не
  попадает в кликабельный URL, а домен без схемы нормализуется в HTTPS.
- Локальный live-smoke 2026-08-16 подтвердил NDJSON-цепочку всех шести этапов:
  Geoapify вернул 100 карточек и 99 именованных лидов, Details успешно получен
  для 20 из 20 карточек, URL сайта присутствовал у 19 лидов. В журнал записаны
  только агрегаты; ключ и полные карточки не сохранялись.

## [0.2.0] — 2026-08-16

### Добавлено

- Geoapify Geocoding API и Places API как основной live-источник организаций.
- Серверная переменная `GEOAPIFY_API_KEY` и явный выбор источника через
  `SEARCH_PROVIDER`.
- Нормализованный контракт provider: ID источника, момент запроса, политика
  хранения, атрибуция и сведения о покрытии категорий.
- Массив наблюдений `sources` у лида для будущего объединения нескольких
  источников без потери происхождения данных.
- Видимая атрибуция Geoapify и OpenStreetMap для live-результатов.
- Пошаговая настройка, правила Free plan и черновик будущего fallback в
  [`docs/geoapify-setup.md`](docs/geoapify-setup.md).

### Бизнес-логика

Причина: API Яндекса технически работал нестабильно в текущем сценарии, а его
опубликованные ограничения не давали безопасно использовать ответы как
постоянную обогащаемую лид-базу. Для рабочего MVP выбран источник, который
допускает коммерческое использование Free plan при обязательной атрибуции.

Новое поведение:

- город или адрес сначала геокодируется, после чего Places API ищет POI в
  заданном радиусе;
- пользовательские термины сопоставляются с иерархическими категориями
  Geoapify, а не отправляются как неограниченный полнотекстовый поиск;
- результат по-прежнему называется обнаруженной выборкой, а не полным реестром;
- нулевой ответ не считается доказательством отсутствия компаний;
- отсутствие URL означает только «сайт не указан источником»;
- карточки без выполненного Place Details получают отдельный статус «данные не
  проверены» и не считаются кандидатами без сайта;
- фильтр сайта работает по наличию URL у источника и не выдаёт это за
  техническую или владельческую проверку сайта;
- live-ошибка не подменяется синтетическими карточками.

### Источники, хранение и лицензия

- В `0.2.0` активен только один live-провайдер — Geoapify; автоматический
  fallback и одновременная агрегация источников не реализованы.
- Нормализованные результаты Geoapify разрешено использовать при сохранении
  требуемой атрибуции; полные raw-ответы провайдера LeadRadar не сохраняет.
- Для Free plan интерфейс показывает `Powered by Geoapify` и
  `© OpenStreetMap contributors`.
- Экспериментальный адаптер Яндекса оставлен выключенным и сохраняет прежние
  ограничения до письменного разрешения на нужный data flow.
- Следующий источник можно будет добавить отдельным адаптером; перед включением
  обязательно проверяются права на хранение, обогащение и экспорт.

Официальные источники:

- [Places API](https://apidocs.geoapify.com/docs/places/);
- [тарифы](https://www.geoapify.com/pricing/);
- [стоимость запросов](https://www.geoapify.com/pricing-details/);
- [Terms and Conditions](https://www.geoapify.com/terms-and-conditions/).

### Безопасность

- `GEOAPIFY_API_KEY` читается только на сервере и не имеет префикса
  `NEXT_PUBLIC_`.
- Экспорт экранирует формулы из внешних данных перед открытием CSV в табличном
  редакторе.
- CSV сохраняет обязательную атрибуцию Geoapify и OpenStreetMap, а локальный
  dev-сервер слушает только `127.0.0.1`, чтобы не открывать квоту всей сети.
- Реальный ключ не добавлен в `.env.example`, документацию или Git.
- Live smoke test выполнен с ключом из игнорируемого `.env.local`; ключ и raw
  ответы не записаны в документацию или Git.
- Поскольку использованный ключ ранее появился вне серверного окружения, перед
  внешним deployment он должен быть отозван и заменён новым.

### Совместимость

- Публичный `POST /api/search` сохраняет прежний входной контракт.
- Ответ расширен provider-метаданными и происхождением лида; режим
  `geoapify` добавлен обратно совместимо для клиентов, которые не ограничивают
  `mode` закрытым списком старых значений.
- Demo-режим остаётся доступным явно и при отсутствии рабочей live-конфигурации.

### Известные ограничения

- Geoapify Places выполняет категорийный POI-поиск и не гарантирует полноту
  малого бизнеса в России.
- Полнота телефонов, сайтов и социальных сетей зависит от исходных открытых
  данных.
- Автоматический fallback, aggregation, фоновая пагинация и мониторинг бюджета
  ещё не реализованы.

### Проверка

- Реальный geocoding, Places и top-20 Place Details проверены 2026-08-15.
- Place Details успешно получен для 20 из 20 карточек контрольной выборки:
  телефон присутствовал у 14, email у 11, сайт у 15.
- В финальном прогоне из 99 лидов цифровой разрыв по сайту подтверждён только у
  5 карточек с полученным Details; 79 карточек без Details остались
  непроверенными, а не были ошибочно классифицированы как «без сайта».
- `office.logistics` и `rental.storage` оставлены основными категориями текущего
  сценария; `building.industrial` исключена из live-поиска MVP из-за высокой
  доли безымянных промышленных объектов в контрольной выборке.
- Метрики описывают одну контрольную выборку и не являются оценкой полноты рынка.

## [0.1.0] — 2026-08-15

### Добавлено

- Локальное веб-приложение LeadRadar с четырьмя рабочими представлениями:
  поисковое задание, таблица, карта и карточка лида.
- Demo-режим с восемью синтетическими организациями.
- Серверный `GET/POST /api/search`.
- Подготовленный адаптер официального API Поиска по организациям Яндекса.
- Фильтры, сортировка, пагинация, статусы, заметки и CSV для demo-данных.
- Локальное сохранение demo-поиска и рабочих заметок.
- Объяснимые оценки коммерческого потенциала, скрытости и достоверности.
- Интерактивная карта Leaflet/OpenStreetMap для demo-режима.
- Документация по запуску, версиям, roadmap и следующему live smoke test.

### Бизнес-логика

- LeadRadar определён как discovery-система, а не полный реестр рынка.
- Поиск использует один основной и до семи смежных запросов.
- Организации, найденные только расширенными формулировками, выделяются отдельно.
- Отсутствие URL означает только «сайт не указан в карточке источника».
- Коммерческий потенциал является эвристикой, а не вероятностью сделки.
- Скрытость показывает трудность обнаружения выбранным поисковым сценарием.
- Достоверность показывает полноту данных, а не финансовую надёжность компании.

### Поиск и данные

- Центр географии определяется отдельным запросом.
- Поиск организаций использует `type=biz`, `ll`, `spn` и `rspn=1`.
- После ответа выполняется точная проверка кругового радиуса.
- Запрашивается до 50 результатов на один термин.
- Дедупликация использует ID, URI или комбинацию названия и адреса.
- Исключения применяются по названию, адресу и категориям.
- Ошибка live-источника не подменяется демоданными молча.

### Compliance-решение

Причина: актуальные официальные страницы Яндекса неоднозначно описывают право на
сохранение и изменение результатов. Страница продукта рекламирует расширенную
лицензию, но коммерческая документация и общие условия ограничивают сохранение,
обработку, изменение порядка и показ на сторонней карте.

Новое поведение:

- наличие `YANDEX_MAPS_API_KEY` само по себе не включает live UI;
- live UI дополнительно требует `YANDEX_LIVE_UI_ENABLED=true`;
- значение по умолчанию — `false`;
- сохранённый ранее live-ответ не восстанавливается из `localStorage`;
- live-ответ не сохраняется локально, не экспортируется в CSV и не показывается
  на сторонней карте;
- до письменного подтверждения Яндекса реальная проверка проводится отдельным
  transient smoke test без сохранения ответа.

Затронуто: `GET/POST /api/search`, `.env.example`, README и roadmap.

Источники:

- [страница продукта API ППО](https://yandex.ru/maps-api/products/geosearch-api);
- [коммерческая документация](https://yandex.ru/dev/commercial/doc/ru/concepts/geosearch);
- [условия API Яндекс Карт](https://yandex.ru/legal/maps_api/ru/).

### Безопасность

- API-ключ читается только на сервере.
- Внешний запрос ограничен таймаутом 15 секунд.
- Ошибки не содержат исходный URL запроса или API-ключ.
- `.env.local` и build-кэши исключены из Git; правила проекта запрещают
  создавать или коммитить raw-ответы провайдера.
- Удалена неиспользуемая заготовка базы данных; production- и dev-зависимости
  baseline проходят `npm audit` без известных уязвимостей.

### Проверка

- Production build проходит.
- ESLint проходит.
- Протестированы SSR, health endpoint, demo-ответ и валидация запроса.
- Имя пакета и версия API проверяются автоматически.
- Реальный API Яндекса ещё не проверен; это следующая задача.

### Известные ограничения

- Нет пагинации после первых 50 результатов одного запроса.
- Нет проверки сайтов и социальных сетей.
- Нет постоянной серверной базы и фоновой очереди.
- Поиск не гарантирует полноту рынка.
- Постоянная база из данных Яндекса, собственный scoring, CSV и отображение на
  OpenStreetMap требуют отдельного разрешения или другого источника данных.
