// ============================================================
// 실데이터 랭킹 수집 — World Bank Open Data API (무료·무키·CC-BY)
//   1) 전 국가 최신값 수집 (집계권역 제외)
//   2) 실제 세계 순위 계산
//   3) 상위권 + 필수 포함국(미·중·일·한 등) 선별
// ============================================================

const WB = 'https://api.worldbank.org/v2';

// 지표 사전 (친화 이름 → World Bank 지표 ID)
export const INDICATORS = {
  fertility: { id: 'SP.DYN.TFRT.IN', nameKo: '출산율', nameEn: 'Fertility Rate' },
  gdpPerCapita: { id: 'NY.GDP.PCAP.CD', nameKo: '1인당 GDP', nameEn: 'GDP per Capita' },
  lifeExpectancy: { id: 'SP.DYN.LE00.IN', nameKo: '기대수명', nameEn: 'Life Expectancy' },
  population: { id: 'SP.POP.TOTL', nameKo: '인구', nameEn: 'Population' },
  internetUsers: { id: 'IT.NET.USER.ZS', nameKo: '인터넷 이용률', nameEn: 'Internet Usage' },
  unemployment: { id: 'SL.UEM.TOTL.ZS', nameKo: '실업률', nameEn: 'Unemployment' },
};

// 주요국 한글 이름 (없으면 영문 그대로)
const KO_NAMES = {
  KR: '대한민국', KP: '북한', US: '미국', CN: '중국', JP: '일본', DE: '독일', GB: '영국', FR: '프랑스',
  IT: '이탈리아', CA: '캐나다', AU: '호주', ES: '스페인', NL: '네덜란드', CH: '스위스',
  SE: '스웨덴', NO: '노르웨이', DK: '덴마크', FI: '핀란드', IS: '아이슬란드', IE: '아일랜드',
  LU: '룩셈부르크', BE: '벨기에', AT: '오스트리아', SG: '싱가포르', HK: '홍콩', TW: '대만',
  IN: '인도', ID: '인도네시아', BR: '브라질', MX: '멕시코', AR: '아르헨티나', CL: '칠레',
  RU: '러시아', TR: '튀르키예', SA: '사우디', AE: '아랍에미리트', IL: '이스라엘', QA: '카타르',
  NZ: '뉴질랜드', TH: '태국', VN: '베트남', PH: '필리핀', MY: '말레이시아', EG: '이집트',
  NG: '나이지리아', ZA: '남아공', KE: '케냐', ET: '에티오피아', NE: '니제르', TD: '차드',
  ML: '말리', SO: '소말리아', CD: '콩고민주공화국', AO: '앙골라', MC: '모나코', LI: '리히텐슈타인',
  BM: '버뮤다', KY: '케이맨제도', MO: '마카오', PL: '폴란드', PT: '포르투갈', GR: '그리스',
  CZ: '체코', HU: '헝가리', UA: '우크라이나', PK: '파키스탄', BD: '방글라데시', IR: '이란',
};

const cache = new Map(); // key → { at, data }
const TTL = 6 * 60 * 60 * 1000;

async function wbJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`World Bank API ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('World Bank 응답 형식 오류');
  return data[1];
}

// 실존 국가 ISO3 집합 (집계권역 제외) — 1회 캐시
async function realCountries() {
  const hit = cache.get('__countries');
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const rows = await wbJson(`${WB}/country?format=json&per_page=400`);
  const map = new Map(); // iso3 → iso2
  for (const c of rows) {
    if (c.region?.value !== 'Aggregates' && c.iso2Code?.length === 2) map.set(c.id, c.iso2Code);
  }
  cache.set('__countries', { at: Date.now(), data: map });
  return map;
}

/**
 * 지표의 전 국가 실제 순위 + 선별.
 * @param {object} p { indicator, top=3, include='us,cn,jp,kr', order='desc' }
 * @returns { ok, indicator, year, totalCountries, items:[{iso2,nameEn,nameKo,value,rank}] }
 */
export async function fetchRanking({ indicator, top = 3, include = 'us,cn,jp,kr', order = 'desc', bottom = 0 }) {
  const ind = INDICATORS[indicator];
  if (!ind) return { ok: false, error: `알 수 없는 지표: ${indicator} (가능: ${Object.keys(INDICATORS).join(', ')})` };

  const ck = `${ind.id}|${order}`;
  let ranked = cache.get(ck)?.at > Date.now() - TTL ? cache.get(ck).data : null;

  if (!ranked) {
    const countries = await realCountries();
    const rows = await wbJson(`${WB}/country/all/indicator/${ind.id}?format=json&mrv=1&per_page=400`);
    const vals = rows
      .filter((r) => r.value !== null && countries.has(r.countryiso3code))
      .map((r) => ({
        iso2: countries.get(r.countryiso3code).toUpperCase(),
        nameEn: r.country.value,
        value: r.value,
        year: r.date,
      }));
    vals.sort((a, b) => (order === 'asc' ? a.value - b.value : b.value - a.value));
    ranked = vals.map((v, i) => ({ ...v, rank: i + 1, nameKo: KO_NAMES[v.iso2] || v.country?.value || v.nameEn }));
    cache.set(ck, { at: Date.now(), data: ranked });
  }

  // 선별: 상위 top + 필수 포함국
  const must = String(include).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const picked = new Map();
  for (const r of ranked.slice(0, Math.max(0, top))) picked.set(r.iso2, r);
  const nBottom = Math.max(0, Number(bottom) || 0);
  if (nBottom > 0) for (const r of ranked.slice(-nBottom)) picked.set(r.iso2, r); // 최하위 N (꼴찌 리빌용)
  for (const code of must) {
    const r = ranked.find((x) => x.iso2 === code);
    if (r) picked.set(r.iso2, r);
  }
  const items = [...picked.values()].sort((a, b) => (order === 'asc' ? a.value - b.value : b.value - a.value));

  return {
    ok: true,
    indicator,
    indicatorName: { ko: ind.nameKo, en: ind.nameEn },
    year: items[0]?.year,
    totalCountries: ranked.length,
    items: items.map((r) => ({ iso2: r.iso2, nameEn: r.nameEn, nameKo: r.nameKo, value: r.value, rank: r.rank })),
  };
}
