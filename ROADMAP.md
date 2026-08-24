# LeadRadar Roadmap

Актуально на: 2026-08-20

Текущая версия: `0.4.0-alpha.1`

Статус: локальный alpha переводит свободный запрос в open-vocabulary
`SemanticIntentV2` через Kimi и только после server-side compilation обращается
к Geoapify. Полный versioned registry из 813 категорий компилируется в bounded
precision, recall, adjacent и name-fallback arms; обычные и редкие физические
ниши больше не требуют ручного добавления сегмента. Production release и
внешний SLA имеют решение `NO-GO` до закрытия quality, reliability и security
gates. Issue #11 остаётся открытым: real production-orchestrator выполнил все
12 сценариев, но fixed-k Precision@10 `0.7500` не достиг порога `0.85`, а
encoder p95 остаётся выше целевых 20 секунд.

## Цель продукта

LeadRadar помогает находить B2B-компании, которые плохо представлены в обычной
поисковой выдаче, объединять результаты разных формулировок и определять, каким
компаниям потенциально нужны сайт, CRM, автоматизация или другие услуги.

Результат является обнаруженной выборкой, а не полным реестром. У каждого
вывода должны быть источник, время наблюдения и уровень уверенности.

## Приоритеты

- **P0** — блокирует безопасное или технически корректное использование.
- **P1** — напрямую влияет на качество лидов и продажи.
- **P2** — повышает масштабируемость и удобство.
- **P3** — оптимизация после подтверждения бизнес-ценности.

## База 0.3.x: выполнено

### Выполнено. Управляемая область поиска и живой прогресс

- Адрес можно геокодировать серверно и проверить на карте до запуска поиска.
- Центр выбирается кликом или перетаскиванием маркера; круг соответствует
  фактическому радиусу запроса.
- `POST /api/search?stream=1` сообщает этапы поиска в NDJSON, а обычный
  `POST /api/search` сохраняет совместимый JSON-контракт.
- Интерфейс показывает валидацию, geocoding, Places, получение Details,
  нормализацию и завершение, включая доступные счётчики.
- Сайты из разрешённых результатов открываются прямо из таблицы.
- Карта результатов открывается на выбранном центре и радиусе; для задания без
  зафиксированной точки стартовым центром остаётся Москва.

Критерий выполнен: выбранные координаты передаются в provider без повторного
geocoding, поток завершается нормализованным результатом, а старый JSON endpoint
остаётся рабочим.

### Выполнено. Live smoke test Geoapify

2026-08-15 подтверждён фактический ответ Geocoding и Places с ключом из
игнорируемого `.env.local`. Place Details успешно получен для 20 из 20 карточек
контрольной выборки: телефон присутствовал у 14, email у 11, сайт у 15. Ключ и
полные ответы не записывались в Git или документацию. В финальном прогоне из 99
лидов сайт не был указан у 5 карточек с полученным Details; 79 необогащённых
карточек помечены как непроверенные и не попадают в digital-gap автоматически.

Перед внешним deployment остаётся:

1. Отозвать использованный ключ, поскольку он ранее появился вне серверного
   окружения.
2. Выпустить отдельный production-ключ и записать его только в secret storage
   среды размещения.
3. Ограничить ключ настройками проекта, включить мониторинг квоты и повторить
   короткий smoke test production-среды.
4. Закрыть `POST /api/search` аутентификацией и серверным лимитом запросов;
   локальный MVP доступен только через `127.0.0.1`.

Инструкция: [`docs/geoapify-setup.md`](docs/geoapify-setup.md).

Локальный критерий выполнен: live-ответ содержит реальные POI, ключ отсутствует
в документации и Git, а source metadata и атрибуция предусмотрены контрактом.

### P0. Проверка категорий и качества по России

Geoapify выполняет категорийный POI-поиск. До использования в продажах нужно
собрать измеримый словарь соответствий для трёх ниш:

Основной запрос текущего сценария фулфилмента использует `office.logistics` и
`rental.storage`. Категория `building.industrial` исключена из live-поиска MVP,
потому что контрольная выборка была заполнена преимущественно безымянными
промышленными объектами. Отдельный аудит этой категории остаётся будущим
экспериментом и не должен смешиваться с выдачей организаций.

- фулфилмент и складские услуги;
- стоматологии;
- автосервисы.

Для Москвы и одного малого города измерить количество уникальных карточек,
`precision@20`, долю телефонов и сайтов, дубли и вклад каждого смежного запроса.
Нулевой ответ или низкая полнота — сигнал уточнить taxonomy или добавить
независимый источник, но не доказательство отсутствия бизнеса.

Критерии: `precision@20 ≥ 70%`, необъяснимые дубли `≤ 5%`, у каждого результата
известны provider, внешний ID, время наблюдения и причина обнаружения.

### P1. Provider adapters — ручной выбор готов, failover в будущем

В `0.4.0-alpha.1` доступны два выбираемых live-адаптера: Geoapify и 2GIS.
`SEARCH_PROVIDER` включает только один источник организаций на поиск;
автоматического failover и смешивания выдач нет. При выборе 2GIS существующий
Geoapify Geocoding может определить центр, после чего организации ищутся только
в 2GIS. Ответы 2GIS остаются `contract_required` до письменного подтверждения
прав на хранение и экспорт. Публичный контракт поиска по-прежнему отделён от
provider-адаптеров, чтобы позднее добавить Overture или договорной каталог.

Правила будущего failover:

1. Резерв запускается только при timeout, `429` или `5xx`.
2. Нулевой результат, `400` и неподдерживаемая категория не являются сбоем.
3. Demo-данные никогда не маскируются под live-fallback.
4. Для каждого факта сохраняются источник и время наблюдения.
5. Aggregation нескольких каталогов проектируется отдельно от failover.
6. До подключения адаптера проверяются лицензия, атрибуция, стоимость и право
   на хранение и экспорт.

Детали черновика: [`docs/geoapify-setup.md`](docs/geoapify-setup.md).

### P1. Качество обнаружения 0.3.x

- Стабилизация абстракции поставщиков данных.
- Отраслевые словари и шаблоны смежных запросов.
- Разбиение территории на поисковые области.
- Пагинация там, где её допускает источник.
- Объяснимая дедупликация филиалов.
- Раздельное хранение фактов источника и собственных выводов.
- Измерение вклада каждого смежного запроса.

### Отложено. API Яндекса

Экспериментальный адаптер остаётся выключенным. Его transient smoke test и
возможное использование описаны в
[`docs/yandex-live-test.md`](docs/yandex-live-test.md). Постоянное хранение,
scoring, экспорт и показ на сторонней карте не включаются без письменного
подтверждения разрешённого data flow.

## Сейчас: 0.4.0-alpha.1 — Query Intelligence

Приоритет: P1.

Выполнено в alpha:

- 40 canonical concepts, независимых от конкретного картографического API;
- exact/synonym/fuzzy resolver сохранён как временный server-side compatibility
  compiler для уже исполняемых ниш; Kimi больше не получает его кандидатов;
- strict Kimi SSE с `[DONE]`, AJV validation, bounded open-vocabulary schema и
  запретом исполняемых provider-параметров;
- open-vocabulary `SemanticIntentV2`: Kimi получает свободную формулировку без
  taxonomy/candidate list и возвращает bounded отрасли, типы бизнеса, услуги,
  include/exclude signals и retrieval terms; URL, координаты и provider filters
  запрещены контрактом и локальной валидацией;
- `POST /api/search/plan`, новый `SearchPlan` в search response и визуальная
  трактовка запроса до обращения к картам;
- semantic confirmation без canonical IDs: opaque alternative hash, отдельный
  retrieval preview и stateless HMAC token с TTL, `requestCacheKey`, исходным
  `planHash`, semantic/compiler versions и `parentPlanHash`;
- server-side compilation provider-neutral retrieval terms против полного
  pinned registry Geoapify; legacy canonical IDs используются только как
  compatibility fallback известных ниш;
- bounded retrieval: до четырёх arms/Places-запросов и 200 карточек, отдельные
  arm budgets, стабильные IDs и primary/adjacent/fallback provenance;
- server-owned name fallback для понятного физического intent без узкой
  provider category; model-authored categories и filters не исполняются;
- дедупликация между arms с сохранением всех причин обнаружения и применение
  exclusions до Details;
- evidence-based relevance после дедупликации и до Details: единые статусы
  `matched/maybe/rejected/not_checked`, доказательства только из разрешённых
  полей карточки, Details только для `matched/maybe`, отдельные фильтры и
  счётчики без скрытия отклонённых карточек;
- RU support и пилотные locale/country-контракты BY/KZ, по одной стране на
  поиск;
- frozen open-world planner gate: 500 cases, 150 family-level групп, 100 типов
  физических организаций, split `60/20/20`, две независимые слепые разметки и
  Cohen's kappa `1.0000`; frozen deterministic relevance gate содержит 600
  явно размеченных synthetic CandidateEvidence по 150 provider targets (по
  150 на каждый статус, retrieval context отделён от labels), прежние 222 planner
  cases сохранены как compatibility suite;
- open-vocabulary encoder проверен реальным `kimi-k3` на барбершопе,
  спортивном зале и ремонте телефонов: валидные ответы заняли 13,8–30,3 с;
- Issue #11 production-orchestrator canary выполнен 20.08.2026 на 12 live
  cases в пяти городах и трёх странах: schema/executable rate `1.0000`, safety
  `0`, 90 уникальных релевантных организаций против 44 у literal baseline.
  Однако fixed-k Precision@10 `0.7500` не прошёл порог `0.85`, поэтому сам
  Issue #11, migration Issue #12 и production release остаются
  заблокированными. Encoder p95 29 073 мс также не прошёл целевые 20 секунд;
- география переключается между городом, районом, метро, областью и ручным
  радиусом; для метро доступны все семь действующих систем России, поиск
  конкретной станции, 1,5 км по умолчанию и server-side Geoapify fallback;
  неоднозначные совпадения требуют явного выбора, а fallback защищён deadline,
  rate limit и суточным каталог-кэшем.

Частично выполнено:

- полный Geoapify registry, bounded multi-arm compiler, open-world intent corpus
  500/500 и deterministic relevance corpus 600/600 готовы; optional post-search
  Kimi classifier остаётся отдельным data-flow/live-quality gate;
- provider-native category hint реализован как bounded default-off refinement.
  В Issue #11 canary было три обращения (`no_match=1`, `resolved=2`) без
  `degraded`, но включать механизм по умолчанию без более широкой выборки
  нельзя;
- provider adapter принимает скомпилированные категории, но geocoding,
  exclusions/dedupe и Details ещё не вынесены в отдельный двухфазный search
  service;
- in-process cache ограничен 200 планами и TTL 10 минут вместо целевой
  production-политики;
- единый 60-секундный server-side deadline, сквозной AbortSignal, terminal
  guard и heartbeat `≤ 2 с` реализованы; controlled-clock suite подтверждает
  100/100 long-running simulations, но live p95 ещё требует калибровки.

Не выполнено и блокирует production `v0.4.0`:

- optional post-search Kimi остаётся за отдельным data-flow/rate gate; его
  метрики пока `N/A`, обязательный deterministic relevance corpus 600/600 готов;
- auth, shared/multi-instance admission и server-side quota limiter; текущие
  scheduler/circuit breaker/metrics являются только in-process Tier-0;
- browser E2E, mock load 1000/concurrency 10, 100 live intents на модель,
  stability 30×3 и 30 реальных поисковых задач;
- официальный MFJS `walle` gate и versioned production evaluation с решением
  `GO`;
- cost gate остаётся неполным: Issue #11 canary использовал 11 346 input и
  6 683 output tokens; оценка `$0.134283` покрывает usage всех 12 attempts, но
  выборка недостаточна для внешнего cost SLA.

Текущие сроки ответа являются внутренней гипотезой, а не SLA. Issue #11 canary
наблюдал first-progress p95 83 мс, encoder p95 29 073 мс, terminal p95
35 539 мс и semantic-journey p95 35 539 мс на 12 attempts. Terminal-цель 55 с
и global per-request deadline 60 с выполнены, но
encoder-цель 20 с не выполнена. Production target после минимум Tier-1 —
`p95 ≤ 25 с` и deadline `45 с`.
Первые 500 jobs/7 дней нужны только для калибровки. Внешний SLA не публикуется
до минимум 10 000 репрезентативных jobs за 28 дней.

## Следующие шаги до production v0.4.0

1. Поднять fixed-k Precision@10 с `0.7500` до `0.85`: измерить 2GIS на
   неизменённой размеченной выборке, улучшить grounding редких ниш и затем
   повторить Issue #11 canary.
2. Добавить auth, shared quota/admission limiter и multi-instance telemetry;
   in-process Tier-0 scheduler, circuit breaker и deadline уже готовы.
3. Завершить двухфазную provider boundary и измерить качество relevance до
   enrichment на размеченной выборке.
4. После разрешения data-flow добавить отдельный live Kimi relevance benchmark;
   deterministic relevance 600/600 и open-world planner 500/500 уже готовы.
5. Прогнать model comparison, stability, browser E2E, load и 30 реальных
   search tasks с versioned обезличенным отчётом.
6. Снизить encoder p95 до 20 с, закрыть полный token/cost gate и измерить минимум
   100 поисков и 50 Kimi calls для local SLO.
7. Только после всех hard gates и `GO` выпускать/tag `v0.4.0`.

Архитектура и исполнимое ТЗ:

- [`docs/semantic-query-planner-architecture.md`](docs/semantic-query-planner-architecture.md);
- [`docs/v0.4.0-query-intelligence-spec.md`](docs/v0.4.0-query-intelligence-spec.md).

## Версия 0.5.0 — проверка цифрового присутствия

Приоритет: P1 после Query Intelligence.

- Проверка доступности указанного сайта.
- Поиск официального сайта через разрешённые источники.
- Проверка принадлежности домена компании.
- Обнаружение Telegram, VK и других каналов.
- Журнал доказательств с URL, источником и временем проверки.
- Разделение статусов «не указан», «найден дополнительно», «не найден после
  проверки», «недоступен» и «требует ручной проверки».

Критерии: нет категоричного «нет сайта» без проверки; ложные выводы о цифровом
разрыве `≤ 10%` на ручной контрольной выборке.

## Версия 0.6.0 — рабочий процесс продаж

Приоритет: P1 после разрешения на хранение.

- Проекты и сохранённые задания.
- Ответственный, статусы, заметки и история действий.
- Персонализированный черновик предложения.
- Экспорт только разрешённых данных.
- CRM-интеграция и список «не связываться».

Критерий: пользователь получает готовый к работе список за 10 минут, а
происхождение каждого поля известно.

## Параллельный gate — проверка бизнес-эффекта

Приоритет: P0, начинается до завершения `v0.4.0` и не откладывается до CRM.

- Выбрать одну нишу и один регион.
- Вручную проверить 50 лидов.
- Провести ограниченный цикл контактов.
- Измерить релевантность, дозвон, квалифицированные разговоры и встречи.
- Сравнить основной поиск против расширенного.

Продолжение разработки определяется фактической воронкой, а не числом карточек.
Минимальный успех: две независимые команды готовы повторно заплатить за новую
проверенную выборку; иначе расширение feature scope приостанавливается.

## Версия 1.0.0 — внутренний production

Приоритет: P2.

- Авторизация и постоянная БД только для разрешённых данных.
- Фоновые задания, rate limiting и контроль бюджета.
- Аудит действий, мониторинг ошибок и стоимости.
- Резервное копирование и политика удаления.
- Unit, integration и end-to-end тесты.

Критерии: юридически допустимый data flow, восстановление после сбоя,
отсутствие секретов в клиенте и логах, предсказуемая стоимость и подтверждённая
ценность для продаж.

## Основные риски

| Риск | Уровень | Мера |
|---|---:|---|
| Лицензия не разрешает базу и экспорт | Критический | Письменное согласование или другой источник |
| Поисковая выдача неполна | Высокий | Называть результат обнаруженной выборкой |
| Ошибочный вывод «нет сайта» | Высокий | Многоступенчатая проверка и evidence |
| Дубли и филиалы | Высокий | Объяснимая дедупликация и ручное объединение |
| Утечка API-ключа | Высокий | Только server-side env, sanitization и secret scan |
| Kimi неверно понял категорию | Высокий | Strict IntentIR, server registry compiler, confirmation, golden/hidden eval и безопасный fallback |
| Kimi/provider не уложился во время | Средний | Local deadline 60 с и optional-stage degradation реализованы; production profile 45 с и provider partial-result после hard timeout ещё требуют калибровки |
| Передача карточек в Kimi нарушает условия источника или privacy policy | Высокий | Post-search AI выключен до country-specific data-flow review; planner не получает лиды |
| Tier-0 Kimi не выдерживает несколько одновременных пользователей | Высокий | In-process scheduler concurrency 1/queue 1 реализован; внешняя beta только после Tier-1, auth и shared admission limiter |
| Стоимость AI растёт незаметно | Средний | Usage metadata, cost gate и не более одного planner call |
| Низкая конверсия | Высокий | Ранний ручной sales-эксперимент |
| Нежелательные обращения | Высокий | Юридическая проверка и opt-out процесс |

## Официальные источники

- [Geoapify Places API](https://apidocs.geoapify.com/docs/places/)
- [Geoapify Pricing](https://www.geoapify.com/pricing/)
- [Geoapify Pricing Details](https://www.geoapify.com/pricing-details/)
- [Geoapify Terms and Conditions](https://www.geoapify.com/terms-and-conditions/)
- [Kimi API models](https://platform.kimi.ai/docs/models)
- [Kimi API Structured Output](https://platform.kimi.ai/docs/guide/response_format)
- [Kimi API model parameters](https://platform.kimi.ai/docs/api/models-overview)
- [Kimi API rate limits](https://platform.kimi.ai/docs/pricing/limits)
- [API Поиска по организациям](https://yandex.ru/maps-api/docs/geosearch-api/index.html)
- [Формат запроса](https://yandex.ru/maps-api/docs/geosearch-api/request.html)
- [Формат ответа](https://yandex.ru/maps-api/docs/geosearch-api/response.html)
- [Страница продукта и тариф](https://yandex.ru/maps-api/products/geosearch-api)
- [Коммерческая документация](https://yandex.ru/dev/commercial/doc/ru/concepts/geosearch)
- [Условия использования API Яндекс Карт](https://yandex.ru/legal/maps_api/ru/)
