import type {
  CanonicalConcept,
  CanonicalConceptStatus,
  PhysicalPlaceRequirement,
  SupportedLocale,
} from "./types";

export const CANONICAL_TAXONOMY_VERSION = "2026-08-16.1";

type ConceptSeed = {
  id: string;
  parentId: string | null;
  label: string;
  beLabel?: string;
  kkLabel?: string;
  aliases: readonly string[];
  beAliases?: readonly string[];
  kkAliases?: readonly string[];
  negativeAliases?: readonly string[];
  beNegativeAliases?: readonly string[];
  kkNegativeAliases?: readonly string[];
  physicalPlace?: PhysicalPlaceRequirement;
  status?: CanonicalConceptStatus;
};

const CONCEPT_SEEDS = [
  {
    id: "logistics.fulfillment",
    parentId: "logistics",
    label: "Фулфилмент",
    beLabel: "Фулфілмент",
    kkLabel: "Фулфилмент",
    aliases: ["фулфиллмент", "центр исполнения заказов", "комплектация заказов", "обработка заказов маркетплейсов", "упаковка заказов"],
    beAliases: ["апрацоўка заказаў", "камплектацыя заказаў"],
    kkAliases: ["тапсырыстарды өңдеу", "тапсырыстарды жинақтау"],
    negativeAliases: ["камера хранения", "склад индивидуального хранения", "аренда гаража"],
    status: "experimental",
  },
  {
    id: "logistics.warehouse",
    parentId: "logistics",
    label: "Складские услуги",
    beLabel: "Складскія паслугі",
    kkLabel: "Қойма қызметтері",
    aliases: ["склад", "ответственное хранение", "аренда склада", "логистический склад"],
    beAliases: ["адказнае захоўванне", "арэнда склада"],
    kkAliases: ["жауапты сақтау", "қойманы жалға алу"],
    negativeAliases: ["камера хранения", "склад для вещей", "гараж"],
    status: "experimental",
  },
  {
    id: "personal_care.barbershop",
    parentId: "personal_care",
    label: "Барбершоп",
    beLabel: "Барбершоп",
    kkLabel: "Барбершоп",
    aliases: ["мужская парикмахерская", "мужская стрижка", "барбер"],
    beAliases: ["мужчынская цырульня", "мужчынская стрыжка"],
    kkAliases: ["ерлер шаштаразы", "ерлер шаш қию"],
    negativeAliases: ["груминг", "стрижка собак", "обучение парикмахеров"],
    status: "experimental",
  },
  {
    id: "personal_care.beauty_salon",
    parentId: "personal_care",
    label: "Салон красоты",
    beLabel: "Салон прыгажосці",
    kkLabel: "Сұлулық салоны",
    aliases: ["парикмахерская", "косметический салон", "женская парикмахерская", "маникюрный салон", "бьюти салон"],
    beAliases: ["цырульня", "касметычны салон"],
    kkAliases: ["шаштараз", "косметикалық салон"],
    negativeAliases: ["груминг", "стрижка животных", "школа красоты"],
  },
  {
    id: "health.dentist",
    parentId: "health",
    label: "Стоматология",
    beLabel: "Стаматалогія",
    kkLabel: "Стоматология",
    aliases: ["стоматолог", "зубная клиника", "дантист"],
    beAliases: ["зубная клініка", "стаматолаг"],
    kkAliases: ["тіс емханасы", "тіс дәрігері"],
  },
  {
    id: "health.medical_clinic",
    parentId: "health",
    label: "Медицинская клиника",
    beLabel: "Медыцынская клініка",
    kkLabel: "Медициналық клиника",
    aliases: ["частная клиника", "медцентр", "медицинский центр"],
    beAliases: ["медыцынскі цэнтр", "прыватная клініка"],
    kkAliases: ["медициналық орталық", "жеке клиника"],
  },
  {
    id: "health.pharmacy",
    parentId: "health",
    label: "Аптека",
    beLabel: "Аптэка",
    kkLabel: "Дәріхана",
    aliases: ["аптечный пункт", "лекарства"],
    beAliases: ["аптэчны пункт", "лекі"],
    kkAliases: ["дәрі-дәрмек", "дәріхана пункті"],
  },
  {
    id: "automotive.repair",
    parentId: "automotive",
    label: "Автосервис",
    beLabel: "Аўтасэрвіс",
    kkLabel: "Автосервис",
    aliases: ["ремонт автомобилей", "сто", "автомастерская", "шиномонтаж"],
    beAliases: ["рамонт аўтамабіляў", "аўтамайстэрня"],
    kkAliases: ["автокөлік жөндеу", "автошеберхана"],
  },
  {
    id: "automotive.car_wash",
    parentId: "automotive",
    label: "Автомойка",
    beLabel: "Аўтамыйка",
    kkLabel: "Автожуу",
    aliases: ["мойка автомобилей", "детейлинг мойка"],
    beAliases: ["мыйка аўтамабіляў"],
    kkAliases: ["көлік жуу", "автокөлік жуу"],
  },
  {
    id: "automotive.fuel_station",
    parentId: "automotive",
    label: "Автозаправка",
    beLabel: "Аўтазапраўка",
    kkLabel: "Жанармай құю станциясы",
    aliases: ["азс", "заправочная станция", "бензозаправка"],
    beAliases: ["азс", "заправачная станцыя"],
    kkAliases: ["жанармай бекеті", "жқб"],
  },
  {
    id: "automotive.charging_station",
    parentId: "automotive",
    label: "Зарядная станция для электромобилей",
    beLabel: "Зарадная станцыя для электрамабіляў",
    kkLabel: "Электромобиль зарядтау станциясы",
    aliases: ["зарядка электромобилей", "электрозаправка", "эв зарядка"],
    beAliases: ["зарадка электрамабіляў"],
    kkAliases: ["электр көлігін зарядтау", "электр қуаттау бекеті"],
  },
  {
    id: "retail.supermarket",
    parentId: "retail",
    label: "Супермаркет",
    beLabel: "Супермаркет",
    kkLabel: "Супермаркет",
    aliases: ["гипермаркет", "продуктовый супермаркет", "магазин продуктов"],
    beAliases: ["прадуктовы супермаркет", "крама прадуктаў"],
    kkAliases: ["азық-түлік супермаркеті", "азық-түлік дүкені"],
  },
  {
    id: "retail.convenience_store",
    parentId: "retail",
    label: "Магазин у дома",
    beLabel: "Крама каля дома",
    kkLabel: "Үй жанындағы дүкен",
    aliases: ["минимаркет", "магазин повседневных товаров", "небольшой продуктовый магазин"],
    beAliases: ["мінімаркет", "крама штодзённых тавараў"],
    kkAliases: ["шағын маркет", "күнделікті тауарлар дүкені"],
  },
  {
    id: "retail.bakery",
    parentId: "retail",
    label: "Пекарня",
    beLabel: "Пякарня",
    kkLabel: "Наубайхана",
    aliases: ["булочная", "хлебный магазин", "свежая выпечка"],
    beAliases: ["булачная", "свежая выпечка"],
    kkAliases: ["нан дүкені", "жаңа піскен нан"],
  },
  {
    id: "retail.butcher",
    parentId: "retail",
    label: "Мясной магазин",
    beLabel: "Мясная крама",
    kkLabel: "Ет дүкені",
    aliases: ["мясная лавка", "магазин мяса", "мясник"],
    beAliases: ["мясная лаўка", "крама мяса"],
    kkAliases: ["ет сататын дүкен", "қасапхана дүкені"],
  },
  {
    id: "retail.florist",
    parentId: "retail",
    label: "Цветочный магазин",
    beLabel: "Кветкавая крама",
    kkLabel: "Гүл дүкені",
    aliases: ["магазин цветов", "цветочная лавка", "флорист"],
    beAliases: ["крама кветак", "фларыст"],
    kkAliases: ["гүл салоны", "флорист"],
  },
  {
    id: "retail.clothing",
    parentId: "retail",
    label: "Магазин одежды",
    beLabel: "Крама адзення",
    kkLabel: "Киім дүкені",
    aliases: ["одежда", "бутик одежды", "магазин моды"],
    beAliases: ["адзенне", "буцік адзення"],
    kkAliases: ["киім", "сән дүкені"],
  },
  {
    id: "retail.shoes",
    parentId: "retail",
    label: "Обувной магазин",
    beLabel: "Абутковая крама",
    kkLabel: "Аяқ киім дүкені",
    aliases: ["магазин обуви", "обувь", "обувной салон"],
    beAliases: ["крама абутку", "абутак"],
    kkAliases: ["аяқ киім", "аяқ киім салоны"],
  },
  {
    id: "retail.furniture",
    parentId: "retail",
    label: "Мебельный магазин",
    beLabel: "Мэблевая крама",
    kkLabel: "Жиһаз дүкені",
    aliases: ["магазин мебели", "мебельный салон", "мебель на заказ"],
    beAliases: ["крама мэблі", "мэблевы салон"],
    kkAliases: ["жиһаз салоны", "тапсырыспен жиһаз"],
  },
  {
    id: "retail.building_materials",
    parentId: "retail",
    label: "Магазин стройматериалов",
    beLabel: "Крама будматэрыялаў",
    kkLabel: "Құрылыс материалдары дүкені",
    aliases: ["строительные материалы", "строймаркет", "магазин ремонта"],
    beAliases: ["будаўнічыя матэрыялы", "будмаркет"],
    kkAliases: ["құрылыс материалдары", "құрылыс дүкені"],
  },
  {
    id: "retail.electronics",
    parentId: "retail",
    label: "Магазин электроники",
    beLabel: "Крама электронікі",
    kkLabel: "Электроника дүкені",
    aliases: ["бытовая техника", "магазин техники", "электроника"],
    beAliases: ["бытавая тэхніка", "крама тэхнікі"],
    kkAliases: ["тұрмыстық техника", "техника дүкені"],
  },
  {
    id: "retail.pet_store",
    parentId: "retail",
    label: "Зоомагазин",
    beLabel: "Заакрама",
    kkLabel: "Үй жануарлары дүкені",
    aliases: ["товары для животных", "магазин для питомцев", "зоотовары"],
    beAliases: ["тавары для жывёл", "крама для гадаванцаў"],
    kkAliases: ["жануарларға арналған тауарлар", "зоотауарлар"],
    negativeAliases: ["ветеринарная клиника", "груминг салон"],
  },
  {
    id: "food.restaurant",
    parentId: "food",
    label: "Ресторан",
    beLabel: "Рэстаран",
    kkLabel: "Мейрамхана",
    aliases: ["семейный ресторан", "ресторанный зал", "ресторан кухни"],
    beAliases: ["сямейны рэстаран"],
    kkAliases: ["отбасылық мейрамхана"],
  },
  {
    id: "food.cafe",
    parentId: "food",
    label: "Кафе",
    beLabel: "Кафэ",
    kkLabel: "Кафе",
    aliases: ["кофейня", "кофе с собой", "городское кафе"],
    beAliases: ["кавярня", "кава з сабой"],
    kkAliases: ["кофехана", "кофе алып кету"],
  },
  {
    id: "food.fast_food",
    parentId: "food",
    label: "Фастфуд",
    beLabel: "Фастфуд",
    kkLabel: "Фастфуд",
    aliases: ["быстрое питание", "закусочная", "бургерная", "шаурма"],
    beAliases: ["хуткае харчаванне", "закусачная"],
    kkAliases: ["жылдам тамақтану", "дәмхана"],
  },
  {
    id: "hospitality.hotel",
    parentId: "hospitality",
    label: "Гостиница",
    beLabel: "Гасцініца",
    kkLabel: "Қонақ үй",
    aliases: ["отель", "гостиничный комплекс", "бутик отель"],
    beAliases: ["атэль", "гасцінічны комплекс"],
    kkAliases: ["отель", "қонақ үй кешені"],
  },
  {
    id: "hospitality.hostel",
    parentId: "hospitality",
    label: "Хостел",
    beLabel: "Хостэл",
    kkLabel: "Хостел",
    aliases: ["общежитие для туристов", "бюджетное размещение"],
    beAliases: ["бюджэтнае размяшчэнне"],
    kkAliases: ["арзан тұратын орын", "туристік жатақхана"],
  },
  {
    id: "business.coworking",
    parentId: "business",
    label: "Коворкинг",
    beLabel: "Каворкінг",
    kkLabel: "Коворкинг",
    aliases: ["коворкинг центр", "гибкий офис", "рабочее пространство"],
    beAliases: ["гнуткі офіс", "працоўная прастора"],
    kkAliases: ["икемді кеңсе", "жұмыс кеңістігі"],
  },
  {
    id: "business.real_estate_agency",
    parentId: "business",
    label: "Агентство недвижимости",
    beLabel: "Агенцтва нерухомасці",
    kkLabel: "Жылжымайтын мүлік агенттігі",
    aliases: ["риэлтор", "агентство квартир", "риэлторская компания"],
    beAliases: ["рыэлтар", "агенцтва кватэр"],
    kkAliases: ["риэлтор", "пәтер агенттігі"],
  },
  {
    id: "professional.law_firm",
    parentId: "professional",
    label: "Юридическая фирма",
    beLabel: "Юрыдычная фірма",
    kkLabel: "Заң фирмасы",
    aliases: ["юристы", "адвокатская контора", "юридические услуги"],
    beAliases: ["юрысты", "адвакацкая кантора"],
    kkAliases: ["заңгерлер", "адвокат кеңсесі"],
    physicalPlace: "optional",
  },
  {
    id: "professional.accounting",
    parentId: "professional",
    label: "Бухгалтерская компания",
    beLabel: "Бухгалтарская кампанія",
    kkLabel: "Бухгалтерлік компания",
    aliases: ["бухгалтерские услуги", "аутсорсинг бухгалтерии", "бухгалтер"],
    beAliases: ["бухгалтарскія паслугі", "бухгалтар"],
    kkAliases: ["бухгалтерлік қызметтер", "бухгалтер"],
    physicalPlace: "optional",
  },
  {
    id: "technology.it_company",
    parentId: "technology",
    label: "IT-компания",
    beLabel: "IT-кампанія",
    kkLabel: "IT-компания",
    aliases: ["разработка программ", "веб студия", "айти компания", "разработчик сайтов"],
    beAliases: ["распрацоўка праграм", "вэб-студыя"],
    kkAliases: ["бағдарлама әзірлеу", "веб студия"],
    physicalPlace: "optional",
    status: "experimental",
  },
  {
    id: "marketing.advertising_agency",
    parentId: "marketing",
    label: "Рекламное агентство",
    beLabel: "Рэкламнае агенцтва",
    kkLabel: "Жарнама агенттігі",
    aliases: ["маркетинговое агентство", "рекламная компания", "digital агентство"],
    beAliases: ["маркетынгавае агенцтва", "рэкламная кампанія"],
    kkAliases: ["маркетинг агенттігі", "жарнама компаниясы"],
    physicalPlace: "optional",
  },
  {
    id: "services.cleaning",
    parentId: "services",
    label: "Клининговая компания",
    beLabel: "Клінінгавая кампанія",
    kkLabel: "Клининг компаниясы",
    aliases: ["клининг", "уборка помещений", "служба уборки"],
    beAliases: ["прыборка памяшканняў", "служба прыборкі"],
    kkAliases: ["үй-жайларды тазалау", "тазалау қызметі"],
    physicalPlace: "optional",
  },
  {
    id: "services.laundry",
    parentId: "services",
    label: "Прачечная и химчистка",
    beLabel: "Пральня і хімчыстка",
    kkLabel: "Кір жуу және химиялық тазалау",
    aliases: ["прачечная", "химчистка", "стирка белья", "чистка одежды"],
    beAliases: ["пральня", "хімчыстка"],
    kkAliases: ["кір жуу", "химиялық тазалау"],
  },
  {
    id: "services.photography",
    parentId: "services",
    label: "Фотостудия",
    beLabel: "Фотастудыя",
    kkLabel: "Фотостудия",
    aliases: ["фотограф", "фотоателье", "студия фотографии"],
    beAliases: ["фатограф", "фотаатэлье"],
    kkAliases: ["фотограф", "фотоателье"],
    physicalPlace: "optional",
  },
  {
    id: "travel.travel_agency",
    parentId: "travel",
    label: "Турагентство",
    beLabel: "Турагенцтва",
    kkLabel: "Турагенттік",
    aliases: ["туристическое агентство", "турфирма", "путевки"],
    beAliases: ["турыстычнае агенцтва", "турфірма"],
    kkAliases: ["туристік агенттік", "турфирма"],
    physicalPlace: "optional",
  },
  {
    id: "mobility.car_rental",
    parentId: "mobility",
    label: "Прокат автомобилей",
    beLabel: "Пракат аўтамабіляў",
    kkLabel: "Автокөлік жалдау",
    aliases: ["аренда автомобиля", "автопрокат", "машина напрокат"],
    beAliases: ["арэнда аўтамабіля", "аўтапракат"],
    kkAliases: ["көлік жалдау", "автокөлік прокаты"],
  },
  {
    id: "education.driving_school",
    parentId: "education",
    label: "Автошкола",
    beLabel: "Аўташкола",
    kkLabel: "Автомектеп",
    aliases: ["школа вождения", "курсы вождения", "обучение водителей"],
    beAliases: ["школа кіравання", "курсы кіравання"],
    kkAliases: ["көлік жүргізу мектебі", "жүргізуші курстары"],
  },
  {
    id: "education.language_school",
    parentId: "education",
    label: "Языковая школа",
    beLabel: "Моўная школа",
    kkLabel: "Тіл мектебі",
    aliases: ["курсы английского", "центр иностранных языков", "языковые курсы"],
    beAliases: ["курсы англійскай", "цэнтр замежных моў"],
    kkAliases: ["ағылшын тілі курстары", "шет тілдер орталығы"],
  },
] as const satisfies readonly ConceptSeed[];

export type CanonicalConceptId = (typeof CONCEPT_SEEDS)[number]["id"];

const unique = (values: readonly string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

function localizedValues(
  russian: readonly string[],
  belarusian: readonly string[] = [],
  kazakh: readonly string[] = [],
): Record<SupportedLocale, readonly string[]> {
  const ru = unique(russian);
  return {
    "ru-RU": ru,
    "ru-BY": ru,
    "be-BY": unique([...belarusian, ...ru]),
    "ru-KZ": ru,
    "kk-KZ": unique([...kazakh, ...ru]),
  };
}

function buildConcept(seed: ConceptSeed): CanonicalConcept {
  const russianAliases = unique([seed.label, ...seed.aliases]);
  return {
    id: seed.id,
    version: 1,
    parentId: seed.parentId,
    labels: {
      "ru-RU": seed.label,
      "ru-BY": seed.label,
      "be-BY": seed.beLabel ?? seed.label,
      "ru-KZ": seed.label,
      "kk-KZ": seed.kkLabel ?? seed.label,
    },
    aliases: localizedValues(
      russianAliases,
      unique([seed.beLabel ?? seed.label, ...(seed.beAliases ?? [])]),
      unique([seed.kkLabel ?? seed.label, ...(seed.kkAliases ?? [])]),
    ),
    negativeAliases: localizedValues(
      seed.negativeAliases ?? [],
      seed.beNegativeAliases,
      seed.kkNegativeAliases,
    ),
    physicalPlace: seed.physicalPlace ?? "required",
    status: seed.status ?? "supported",
  };
}

export const CANONICAL_TAXONOMY: readonly CanonicalConcept[] = Object.freeze(
  CONCEPT_SEEDS.map(buildConcept),
);

export const CANONICAL_CONCEPT_IDS = Object.freeze(
  CONCEPT_SEEDS.map((concept) => concept.id),
) as readonly CanonicalConceptId[];

const CONCEPT_BY_ID = new Map(CANONICAL_TAXONOMY.map((concept) => [concept.id, concept]));

export function getCanonicalConcept(
  conceptId: string,
): CanonicalConcept | undefined {
  return CONCEPT_BY_ID.get(conceptId);
}

export function canonicalConceptLabel(
  conceptId: string,
  locale: SupportedLocale = "ru-RU",
): string {
  const concept = getCanonicalConcept(conceptId);
  return concept?.labels[locale] ?? concept?.labels["ru-RU"] ?? conceptId;
}

export function isCanonicalConceptId(value: string): value is CanonicalConceptId {
  return CONCEPT_BY_ID.has(value);
}
