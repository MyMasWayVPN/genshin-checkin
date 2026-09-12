/**
 * HoYoverse / HoYoLab API Service
 * Layanan integrasi verifikasi LToken, pencarian role multi-region, dan penukaran redeem code Genshin Impact.
 */
import { getRandomUserAgent } from './user-agents.js';

const DEFAULT_REGIONS = [
  { name: 'Asia Server', region: 'os_asia' },
  { name: 'America Server', region: 'os_usa' },
  { name: 'Europe Server', region: 'os_euro' },
  { name: 'TW, HK, MO Server', region: 'os_cht' },
];

const API_ENDPOINTS = {
  VERIFY_LTOKEN: 'https://passport-api-sg.hoyolab.com/account/ma-passport/token/verifyLToken',
  GET_ALL_REGIONS: 'https://api-account-os.hoyolab.com/binding/api/getAllRegions',
  GET_USER_ROLES: 'https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken',
  REDEEM_CODE: 'https://public-operation-hk4e.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Format string cookie HoYoLab dari ltoken dan ltuid.
 * Mendukung format v2 (ltoken_v2 / ltuid_v2) maupun token standar.
 */
export function formatCookie(ltoken, ltuid) {
  const token = String(ltoken || '').trim();
  const uid = String(ltuid || '').trim();

  if (token.startsWith('v2_')) {
    return `ltoken_v2=${token}; ltuid_v2=${uid}`;
  }
  return `ltoken=${token}; ltuid=${uid}; ltoken_v2=${token}; ltuid_v2=${uid}`;
}

/**
 * Ekstraksi ltoken dan ltuid dari berbagai bentuk parameter (objek account atau parameter terpisah).
 */
function extractCredentials(accountOrLtoken, ltuidParam) {
  if (typeof accountOrLtoken === 'object' && accountOrLtoken !== null) {
    return {
      ltoken: accountOrLtoken.ltoken,
      ltuid: accountOrLtoken.ltuid,
      name: accountOrLtoken.name || 'Account',
    };
  }
  return {
    ltoken: accountOrLtoken,
    ltuid: ltuidParam,
    name: 'Account',
  };
}

/**
 * 1. Verifikasi LToken HoYoLab
 * Menguji validitas LToken dan mendapatkan detail info akun HoYoverse.
 */
export async function verifyLToken(accountOrLtoken, ltuidParam) {
  const { ltoken, ltuid } = extractCredentials(accountOrLtoken, ltuidParam);
  const cookie = formatCookie(ltoken, ltuid);

  const response = await fetch(API_ENDPOINTS.VERIFY_LTOKEN, {
    method: 'POST',
    headers: {
      'User-Agent': getRandomUserAgent(),
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    valid: result.retcode === 0,
    retcode: result.retcode,
    message: result.message,
    data: result.data || null,
    userInfo: result.data?.user_info || null,
  };
}

/**
 * 2. Get All Regions
 * Mengambil daftar server resmi Genshin Impact (hk4e_global).
 */
export async function getAllRegions(gameBiz = 'hk4e_global') {
  try {
    const url = `${API_ENDPOINTS.GET_ALL_REGIONS}?game_biz=${encodeURIComponent(gameBiz)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!response.ok) {
      return DEFAULT_REGIONS;
    }

    const result = await response.json();
    if (result.retcode === 0 && Array.isArray(result.data?.list) && result.data.list.length > 0) {
      return result.data.list;
    }
  } catch {
    // Fallback otomatis jika API regional gagal
  }

  return DEFAULT_REGIONS;
}

/**
 * 3. Get User Game Roles By Region
 * Mengambil daftar karakter game pada region tertentu dengan LToken.
 */
export async function getUserGameRolesByRegion(accountOrLtoken, ltuidParam, region = 'os_asia', gameBiz = 'hk4e_global') {
  const { ltoken, ltuid } = extractCredentials(accountOrLtoken, ltuidParam);
  const cookie = formatCookie(ltoken, ltuid);

  const url = `${API_ENDPOINTS.GET_USER_ROLES}?game_biz=${encodeURIComponent(gameBiz)}&region=${encodeURIComponent(region)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': getRandomUserAgent(),
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const list = result?.data?.list || [];

  return {
    retcode: result.retcode,
    message: result.message,
    data: result.data,
    list,
  };
}

/**
 * 3b. Find User Game Role Across Regions
 * Mencari karakter aktif dengan memeriksa region lain secara otomatis jika nickname / list kosong.
 */
export async function findUserGameRole(accountOrLtoken, ltuidParam, { preferredRegion = 'os_asia', gameBiz = 'hk4e_global' } = {}) {
  const { ltoken, ltuid, name } = extractCredentials(accountOrLtoken, ltuidParam);
  const regions = await getAllRegions(gameBiz);

  // Prioritaskan preferredRegion di urutan pertama
  const sortedRegions = [
    ...regions.filter((r) => r.region === preferredRegion),
    ...regions.filter((r) => r.region !== preferredRegion),
  ];

  for (const item of sortedRegions) {
    const { region, name: regionName } = item;
    try {
      const res = await getUserGameRolesByRegion({ ltoken, ltuid }, null, region, gameBiz);

      if (res.retcode === 0 && Array.isArray(res.list) && res.list.length > 0) {
        // Cari karakter yang memiliki nickname dan game_uid valid
        const validRole = res.list.find((role) => role.nickname && role.nickname.trim() !== '' && role.game_uid);
        if (validRole) {
          return {
            found: true,
            role: validRole,
            uid: validRole.game_uid,
            nickname: validRole.nickname,
            level: validRole.level,
            region: validRole.region || region,
            regionName: validRole.region_name || regionName,
          };
        }
      }
    } catch {
      // Lanjutkan cek region berikutnya jika terjadi kegagalan jaringan sementara
    }

    // Jeda singkat antar request regional
    await delay(300);
  }

  return {
    found: false,
    message: `Tidak ditemukan karakter Genshin Impact dengan nickname valid untuk ${name} di semua region.`,
  };
}

/**
 * 4. Redeem Code (Exchange CDKey)
 * Menukarkan promo code ke UID & region tertentu menggunakan LToken.
 */
export async function redeemCode({
  accountOrLtoken,
  ltuidParam,
  uid,
  region,
  cdkey,
  gameBiz = 'hk4e_global',
  lang = 'en',
}) {
  const { ltoken, ltuid } = extractCredentials(accountOrLtoken, ltuidParam);
  const cleanCdkey = String(cdkey || '').trim();

  if (!cleanCdkey) {
    throw new Error('Kode promo (cdkey) tidak boleh kosong.');
  }
  if (!uid || !region) {
    throw new Error('Parameter uid dan region wajib diisi untuk redeem code.');
  }

  const cookie = formatCookie(ltoken, ltuid);
  const params = new URLSearchParams({
    cdkey: cleanCdkey,
    game_biz: gameBiz,
    lang,
    region,
    t: String(Date.now()),
    uid: String(uid),
  });

  const url = `${API_ENDPOINTS.REDEEM_CODE}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': getRandomUserAgent(),
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
  }

  let result = await response.json();

  // Jika terkena cooldown (HoYoverse batas 5 detik per akun), tunggu 5.5 detik dan retry otomatis
  if (result.retcode === -2016 || /cooldown/i.test(result.message || '')) {
    await delay(5500);
    const retryRes = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'application/json, text/plain, */*',
        Cookie: cookie,
      },
    });
    if (retryRes.ok) {
      result = await retryRes.json();
    }
  }

  const retcode = result.retcode;
  const isSuccess = retcode === 0;
  const isAlreadyClaimed = retcode === -2017;
  const isLimitReached = retcode === -2006;

  return {
    success: isSuccess,
    isAlreadyClaimed,
    isLimitReached,
    retcode,
    message: result.message || 'Tidak ada pesan balasan.',
    cdkey: cleanCdkey,
    uid,
    region,
  };
}

/**
 * 5. Redeem Code Otomatis Untuk Satu Akun
 * Menggabungkan verifikasi role (auto-detect region & UID) lalu menukarkan kode promo.
 */
export async function redeemForAccount(account, cdkey, options = {}) {
  const roleInfo = await findUserGameRole(account, null, options);
  if (!roleInfo.found) {
    return {
      success: false,
      accountName: account.name || 'Account',
      message: roleInfo.message,
    };
  }

  const redeemResult = await redeemCode({
    accountOrLtoken: account,
    uid: roleInfo.uid,
    region: roleInfo.region,
    cdkey,
    lang: options.lang || 'en',
    gameBiz: options.gameBiz || 'hk4e_global',
  });

  return {
    accountName: account.name || 'Account',
    nickname: roleInfo.nickname,
    level: roleInfo.level,
    uid: roleInfo.uid,
    region: roleInfo.regionName,
    ...redeemResult,
  };
}

/**
 * Helper: Parse JSON dari environment secret
 */
export function parseJson(value, secretName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Secret ${secretName} harus berupa JSON valid. ${error.message}`);
  }
}

/**
 * Helper: Normalisasi data akun dari berbagai bentuk penulisan (termasuk alias ltuid/luid)
 */
export function normalizeAccount(account, index, source = 'ENV') {
  const name = account?.name?.trim() || `Akun ${index + 1}`;
  const ltuid = String(account?.ltuid || account?.luid || account?.ltuid_v2 || '').trim();
  const ltoken = String(account?.ltoken || account?.ltoken_v2 || '').trim();

  if (!ltuid || !ltoken) {
    throw new Error(`Data akun ke-${index + 1} (${source}) harus punya ltuid/luid dan ltoken.`);
  }

  return { name, ltuid, ltoken, source };
}

/**
 * Helper: Membaca seluruh akun dari Environment Variables (GitHub Secrets)
 * Mendukung format split GENSHIN_ACCOUNT_1..20 dan legacy GENSHIN_ACCOUNTS
 */
export function loadAccounts() {
  const accounts = [];

  // 1. Baca GENSHIN_ACCOUNTS (bisa berupa Array ataupun Single Object)
  const legacyRaw = process.env.GENSHIN_ACCOUNTS?.trim();
  if (legacyRaw) {
    const parsed = parseJson(legacyRaw, 'GENSHIN_ACCOUNTS');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    list.forEach((acc, idx) => {
      const source = `GENSHIN_ACCOUNTS[${idx + 1}]`;
      const override = process.env[`GENSHIN_ACCOUNTS_${idx + 1}`]?.trim();
      if (override && typeof acc === 'object' && acc !== null) {
        acc.ltoken = override;
      }
      accounts.push(normalizeAccount(acc, accounts.length, source));
    });
  }

  // 2. Baca GENSHIN_ACCOUNT_1 s/d GENSHIN_ACCOUNT_20 (bisa berupa Single Object ataupun Array)
  const splitEntries = Object.entries(process.env)
    .map(([key, val]) => {
      const match = key.match(/^GENSHIN_ACCOUNT_(\d+)$/);
      return match && val?.trim()
        ? { index: Number(match[1]), value: val.trim(), secretName: key }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  for (const item of splitEntries) {
    const parsed = parseJson(item.value, item.secretName);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    list.forEach((acc, subIdx) => {
      const source = list.length > 1 ? `${item.secretName}[${subIdx + 1}]` : item.secretName;
      const override = process.env[`${item.secretName}_LTOKEN`]?.trim();
      if (override && typeof acc === 'object' && acc !== null) {
        acc.ltoken = override;
      }
      accounts.push(normalizeAccount(acc, accounts.length, source));
    });
  }

  return accounts;
}
