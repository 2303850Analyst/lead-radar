# Как провести безопасный live smoke test API Яндекса

Этот тест подтверждает доступ к API Поиска по организациям и фактический
контракт ответа. Он не доказывает полноту базы и не включает live-данные в
рабочий интерфейс LeadRadar.

## Почему тест изолирован от UI

Текущий demo-интерфейс сохраняет результаты в браузере, сортирует их по
собственному score, экспортирует CSV и показывает точки на OpenStreetMap.
Опубликованные условия Яндекса могут запрещать эти действия для ответа API ППО.
Поэтому первый live-тест не использует UI, не сохраняет ответ и не выводит
контакты.

Официальные документы необходимо перепроверить непосредственно перед тестом:

- [быстрый старт](https://yandex.ru/maps-api/docs/geosearch-api/quickstart.html);
- [формат запроса](https://yandex.ru/maps-api/docs/geosearch-api/request.html);
- [формат ответа и ошибки](https://yandex.ru/maps-api/docs/geosearch-api/response.html);
- [тариф и тестовый период](https://yandex.ru/maps-api/products/geosearch-api);
- [условия API](https://yandex.ru/legal/maps_api/ru/);
- [специальные условия API ППО](https://yandex.ru/dev/tariffs/doc/ru/geosearch/terms/).

## Предварительное решение по лицензии

До полноценной интеграции отправьте в `maps-api@support.yandex.ru` описание:

> Планируем использовать API Поиска по организациям во внутреннем LeadRadar:
> сохранять карточки организаций, дополнять их собственными результатами
> проверки сайта, рассчитывать собственные оценки, сортировать и экспортировать
> лиды. Какая лицензия разрешает этот сценарий, допустима ли сторонняя карта и
> каковы условия хранения и объединения данных?

Сохраните ответ как проектное решение, но не добавляйте личную переписку или
коммерческие реквизиты в публичный репозиторий.

## Что нужно получить у Яндекса

1. Войти в [Кабинет разработчика](https://developer.tech.yandex.ru/).
2. Подключить «API Поиска по организациям».
3. На странице продукта запросить тестовый период у менеджера.
4. Создать отдельный ключ LeadRadar и ограничить его внешним IP тестовой машины.
5. Подождать до 15 минут после выпуска или изменения ключа.

По актуальной документации тестовый период может включать до 100 запросов в
сутки на срок до семи дней. Перед запуском подтвердите эти значения в кабинете.

## Секрет

Ключ задаёт владелец проекта локально. Не отправляйте его в чат и не вводите
открытым текстом в команду: такая команда может попасть в историю PowerShell.

```powershell
$secureKey = Read-Host "YANDEX_MAPS_API_KEY" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:YANDEX_MAPS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $secureKey.Dispose()
}
```

Если для других инструментов используется `.env.local`, убедитесь, что файл
игнорируется. После подготовки релиза проверяйте staged index без печати
совпавшей строки:

```powershell
git check-ignore .env.local
git grep --cached -q -E 'YANDEX_MAPS_API_KEY=..+' --
if ($LASTEXITCODE -eq 0) { throw "В staged-файлах найдено возможное значение ключа" }
```

Команда `git grep` должна завершиться с кодом 1: это означает, что совпадений
нет. Она безопаснее обычного вывода diff, потому что не печатает найденное
значение.

## Smoke-запрос без сохранения ответа

Запустите в PowerShell:

```powershell
if (-not $env:YANDEX_MAPS_API_KEY) {
    throw "YANDEX_MAPS_API_KEY не задан"
}

$params = [ordered]@{
    text    = "кофейня"
    type    = "biz"
    lang    = "ru_RU"
    ll      = "37.6173,55.7558"
    spn     = "0.20,0.14"
    rspn    = "1"
    results = "5"
    apikey  = $env:YANDEX_MAPS_API_KEY
}

$query = ($params.GetEnumerator() | ForEach-Object {
    "$([uri]::EscapeDataString($_.Key))=$([uri]::EscapeDataString($_.Value))"
}) -join "&"

$phase = "transport"
try {
    $started = Get-Date
    $response = Invoke-RestMethod `
        -Method Get `
        -Uri "https://search-maps.yandex.ru/v1/?$query" `
        -TimeoutSec 15
    $latencyMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)

    $phase = "response contract"
    if ($response.type -ne "FeatureCollection") {
        throw "unexpected collection type"
    }

    $features = @($response.features)
    if ($features.Count -lt 1 -or $features.Count -gt 5) {
        throw "unexpected result count"
    }

    $validCompanyRecords = 0
    $validCoordinates = 0
    $addressesPresent = 0

    foreach ($feature in $features) {
        $company = $feature.properties.CompanyMetaData
        if ($company -and
            -not [string]::IsNullOrWhiteSpace([string]$company.id) -and
            -not [string]::IsNullOrWhiteSpace([string]$company.name)) {
            $validCompanyRecords += 1
        }

        $address = if ($company.address) {
            [string]$company.address
        } else {
            [string]$company.Address.formatted
        }
        if (-not [string]::IsNullOrWhiteSpace($address)) {
            $addressesPresent += 1
        }

        $coordinates = @($feature.geometry.coordinates)
        if ($coordinates.Count -ge 2) {
            try {
                $longitude = [double]$coordinates[0]
                $latitude = [double]$coordinates[1]
                if ([double]::IsFinite($longitude) -and
                    [double]::IsFinite($latitude) -and
                    $longitude -ge -180 -and $longitude -le 180 -and
                    $latitude -ge -90 -and $latitude -le 90) {
                    $validCoordinates += 1
                }
            } catch {
                # Итоговая проверка ниже завершит тест с безопасной ошибкой.
            }
        }
    }

    if ($validCompanyRecords -ne $features.Count) {
        throw "one or more company records have no id/name"
    }
    if ($validCoordinates -ne $features.Count) {
        throw "one or more records have invalid coordinates"
    }

    [pscustomobject]@{
        Type                = $response.type
        ResultCount         = $features.Count
        ValidCompanyRecords = $validCompanyRecords
        ValidCoordinates    = $validCoordinates
        AddressesPresent    = $addressesPresent
        LatencyMs           = $latencyMs
    }
} catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }
    $statusLabel = if ($statusCode) { "HTTP $statusCode" } else { "без HTTP-кода" }
    throw "Smoke test failed на этапе '$phase' ($statusLabel). Детали upstream скрыты, потому что URI содержит API-ключ."
} finally {
    Remove-Item Env:YANDEX_MAPS_API_KEY -ErrorAction SilentlyContinue
}
```

Не печатайте `$query`: он содержит ключ. Не используйте `Out-File`,
`ConvertTo-Json` или перенаправление вывода для полного ответа. Не включайте
`YANDEX_LIVE_UI_ENABLED`: одно действие текущего UI выполняет несколько запросов
и использует процесс обработки данных, который ещё не согласован.

`Кофейня` — транспортный smoke-запрос: он достаточно широкий, чтобы проверить
контракт. После него можно выполнить отдельный продуктовый запрос
`фулфилмент`; нулевой результат такого запроса является допустимым наблюдением,
а не технической ошибкой.

## Официальные параметры

- Endpoint: `GET https://search-maps.yandex.ru/v1/`.
- Обязательные параметры: `apikey`, `text`, `lang`.
- `type=biz` возвращает организации.
- `ll` и `spn` задают область в порядке `долгота,широта`.
- `rspn=1` запрещает выход за указанную область.
- `results` — максимум 50.
- `skip` — максимум 1000 и должен делиться на `results`.
- Технический предел HTTP API — 50 запросов в секунду суммарно для клиента и
  сервера.

## Критерии приёмки

Smoke test успешен, если:

- получен HTTP 200;
- `type` равен `FeatureCollection`;
- вернулось от одного до пяти объектов;
- каждый объект содержит `CompanyMetaData.id` и `name`;
- заполненность `address` или `Address.formatted` измерена как coverage, но не
  является условием падения теста;
- координаты являются двумя конечными числами в порядке долгота/широта;
- ответ не превышает `results` и сохраняет порядок Яндекса;
- ключ отсутствует в браузере, выводе, логах и Git;
- полный ответ не попал в файл, `localStorage`, CSV или БД;
- обезличенный отчёт содержит только дату, latency, число результатов и
  заполненность полей.

Появление запроса в статистике кабинета проверяется дополнительно: статистика
может обновляться с задержкой и не является жёстким критерием приёмки.

Нельзя использовать критерий «найдены все фулфилменты». Яндекс возвращает
наиболее релевантные объекты, а не полный реестр.

## Ошибки

Следующие статусы относятся к прямому endpoint Яндекса. Встроенный route
LeadRadar нормализует upstream-ошибки и возвращает клиенту HTTP 502 с безопасным
внутренним `code`.

### HTTP 400

Не повторяйте запрос. Проверьте обязательные параметры, пустой `text`,
`results ≤ 50`, координаты, `skip` и URL-кодирование. API возвращает подробность
в поле `message`.

### HTTP 403

Проверьте, что ключ создан для нужного API, активирован, разрешает внешний IP и
после создания прошло до 15 минут. При использовании подписи проверьте её TTL.
Автоматические ретраи для 403 не нужны.

### HTTP 429

Для первого теста не делайте параллельных запросов. В дальнейшем используйте
экспоненциальную задержку с jitter и максимум 2–3 повтора, контролируя дневную
квоту в кабинете.

### Timeout или сеть

Не выводите полный URL из объекта ошибки: в нём может находиться ключ. Повторите
один раз после проверки сети; затем завершите тест как неуспешный.

## Порядок следующей задачи

1. Добавить автоматизированный `scripts/yandex-live-smoke.mjs` по этим же
   правилам и unit-тесты на mock-ответах.
2. Получить ключ и выполнить им один transport smoke `кофейня`.
3. Выполнить один необязательный продуктовый запрос `фулфилмент`, где ноль
   результатов допустим.
4. Зафиксировать только обезличенные метрики и фактическую схему без payload.
5. Получить письменное лицензионное решение.
6. Только при `GO` разработать transient live-экран на Яндекс Карте, сохраняющий
   исходный порядок.
7. Только при разрешении на хранение подключать enrichment, scoring, CSV и CRM.
