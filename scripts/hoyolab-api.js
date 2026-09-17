/**
 * HoYoverse / HoYoLab API Service
 * Layanan integrasi verifikasi LToken, role multi-region, penukaran redeem code,
 * serta fungsi utilitas global (akun, format waktu, promo code, telegram) untuk Genshin Impact.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getRandomUserAgent } from './user-agents.js';

export const DEFAULT_REGIONS = [
  { name: 'Asia Server', region: 'os_asia' },
  { name: 'America Server', region: 'os_usa' },
  { name: 'Europe Server', region: 'os_euro' },
  { name: 'TW, HK, MO Server', region: 'os_cht' },
];

export const API_ENDPOINTS = {
  VERIFY_LTOKEN: 'https://passport-api-sg.hoyolab.com/account/ma-passport/token/verifyLToken',
  GET_ALL_REGIONS: 'https://api-account-os.hoyolab.com/binding/api/getAllRegions',
  GET_USER_ROLES: 'https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken',
  REDEEM_CODE: 'https://public-operation-hk4e.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl',
};

export const DEFAULT_PROMO_FILE = new URL('../promo-codes.json', import.meta.url);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Format string cookie HoYoLab dari ltoken dan ltuid (mendukung format v1 & v2).
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
 * Ekstraksi ltoken dan ltuid dari berbagai bentuk parameter.
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
 */
export async function getUserGameRolesByRegion({ accountOrLtoken, ltuid, region, gameBiz = 'hk4e_global', filterValid = true }) {
  const creds = extractCredentials(accountOrLtoken, ltuid);
  const cookie = formatCookie(creds.ltoken, creds.ltuid);
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
  const rawRoles = Array.isArray(result.data?.list) ? result.data.list : [];
  
  // Filter: Skip karakter dengan nickname kosong atau level di bawah 10 (syarat redeem HoYoverse AR >= 10)
  const roles = filterValid
    ? rawRoles.filter((role) => Boolean(role?.nickname?.trim()) && Number(role?.level || 0) >= 10)
    : rawRoles;

  return {
    success: result.retcode === 0,
    retcode: result.retcode,
    message: result.message,
    roles,
    rawRoles,
  };
}

/**
 * 4. Find User Game Roles (Auto-Detect Region & UID di semua server)
 * Memindai semua region dan mengembalikan semua karakter yang memenuhi filter (Lv >= 10 & nickname terisi)
 */
export async function findUserGameRole(accountOrLtoken, ltuidParam, options = {}) {
  const creds = extractCredentials(accountOrLtoken, ltuidParam);
  const regions = await getAllRegions(options.gameBiz || 'hk4e_global');
  const validRoles = [];

  for (const reg of regions) {
    try {
      const res = await getUserGameRolesByRegion({
        accountOrLtoken: creds,
        region: reg.region,
        gameBiz: options.gameBiz || 'hk4e_global',
        filterValid: options.filterValid ?? true,
      });

      if (res.success && res.roles.length > 0) {
        for (const role of res.roles) {
          validRoles.push({
            accountName: creds.name,
            nickname: role.nickname,
            uid: role.game_uid,
            level: Number(role.level),
            region: role.region,
            regionName: role.region_name || reg.name,
            role,
          });
        }
      }
    } catch {
      // Lanjutkan cek region berikutnya jika terjadi kegagalan
    }
    await delay(options.delayMs || 150);
  }

  if (validRoles.length > 0) {
    const primaryRole = validRoles[0];
    return {
      found: true,
      accountName: creds.name,
      ...primaryRole,
      roles: validRoles,
    };
  }

  return {
    found: false,
    accountName: creds.name,
    roles: [],
    message: 'Tidak ada karakter valid (minimal Level 10 & memiliki Nickname) di semua region.',
  };
}

export const findAllUserGameRoles = findUserGameRole;

/**
 * 5. Redeem Code HoYoLab
 */
export async function redeemCode({ accountOrLtoken, ltuid, uid, region, cdkey, lang = 'en', gameBiz = 'hk4e_global' }) {
  const creds = extractCredentials(accountOrLtoken, ltuid);
  const cleanCdkey = String(cdkey || '').trim();
  const cookie = formatCookie(creds.ltoken, creds.ltuid);

  const query = new URLSearchParams({
    uid: String(uid),
    region: String(region),
    cdkey: cleanCdkey,
    lang,
    game_biz: gameBiz,
  });

  const url = `${API_ENDPOINTS.REDEEM_CODE}?${query.toString()}`;

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

  // Retry otomatis jika terkena cooldown rate-limit dari HoYoverse
  let retryCount = 0;
  while (
    retryCount < 2 &&
    (result.retcode === -2016 || /cooldown|try again in/i.test(result.message || ''))
  ) {
    retryCount += 1;
    const secMatch = result.message?.match(/(\d+)\s*second/i);
    const waitMs = secMatch ? (Number(secMatch[1]) + 1.5) * 1000 : 3500;
    await delay(waitMs);

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
  return {
    success: retcode === 0,
    isAlreadyClaimed: retcode === -2017,
    isLimitReached: retcode === -2006,
    retcode,
    message: result.message || 'Tidak ada pesan balasan.',
    cdkey: cleanCdkey,
    uid,
    region,
  };
}

/**
 * 6. Redeem Code Otomatis Untuk Satu Akun
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

/* =========================================================================
   FUNGSI UTILITAS GLOBAL (SHARED HELPERS)
   ========================================================================= */

/**
 * Validasi dan ambil environment variable wajib
 */
export function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Secret ${name} belum diisi.`);
  }
  return value;
}

/**
 * Format timestamp waktu saat ini dalam WIB (Asia/Jakarta)
 */
export function getWibTime() {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

/**
 * Parse JSON dari environment variable/secret secara aman
 */
export function parseJson(value, secretName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Secret ${secretName} harus berupa JSON valid. ${error.message}`);
  }
}

/**
 * Ambil override LToken khusus dari secret terpisah jika ada
 */
export function getLtokenOverride(secretName) {
  return process.env[`${secretName}_LTOKEN`]?.trim();
}

/**
 * Terapkan override token ke objek akun jika tersedia di environment
 */
export function applyLtokenOverride(account, secretName) {
  const overrideLtoken = getLtokenOverride(secretName);
  if (overrideLtoken && typeof account === 'object' && account !== null) {
    account.ltoken = overrideLtoken;
  }
  return account;
}

/**
 * Normalisasi objek akun dari berbagai variasi penamaan field (ltuid/luid/ltuid_v2 dsb)
 */
export function normalizeAccount(account, index, source = 'ENV', secretName = '') {
  const name = account?.name?.trim() || `Akun ${index + 1}`;
  const ltuid = String(account?.ltuid || account?.luid || account?.ltuid_v2 || '').trim();
  const ltoken = String(account?.ltoken || account?.ltoken_v2 || '').trim();

  if (!ltuid || !ltoken) {
    throw new Error(`Data akun ke-${index + 1} (${source}) harus punya ltuid/luid dan ltoken.`);
  }

  const rawObject = { name, ltuid, ltoken };

  return {
    ...account,
    name,
    ltuid,
    ltoken,
    source,
    secretName: secretName || source,
    rawObject,
  };
}

/**
 * Membaca akun dari secret split GENSHIN_ACCOUNT_1 s/d GENSHIN_ACCOUNT_N
 */
export function loadSplitAccountSecrets(secretGroups = null) {
  return Object.entries(process.env)
    .map(([key, value]) => {
      const match = key.match(/^GENSHIN_ACCOUNT_(\d+)$/);
      return match && value?.trim()
        ? { index: Number(match[1]), value: value.trim(), secretName: key }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .flatMap((item) => {
      const parsed = parseJson(item.value, item.secretName);
      const isArray = Array.isArray(parsed);
      const list = isArray ? parsed : [parsed];
      const group = { secretName: item.secretName, isArray, list: [] };

      const accounts = list.map((acc, subIdx) => {
        const source = isArray ? `${item.secretName}[${subIdx + 1}]` : item.secretName;
        const normalized = normalizeAccount(
          applyLtokenOverride(acc, item.secretName),
          subIdx,
          source,
          item.secretName
        );
        group.list.push(normalized);
        return normalized;
      });

      if (secretGroups && typeof secretGroups.set === 'function') {
        secretGroups.set(item.secretName, group);
      }
      return accounts;
    });
}

/**
 * Membaca akun dari secret legacy GENSHIN_ACCOUNTS
 */
export function loadLegacyAccountsSecret(secretGroups = null) {
  const rawAccounts = process.env.GENSHIN_ACCOUNTS?.trim();
  if (!rawAccounts) return [];

  const parsed = parseJson(rawAccounts, 'GENSHIN_ACCOUNTS');
  const isArray = Array.isArray(parsed);
  const list = isArray ? parsed : [parsed];
  const group = { secretName: 'GENSHIN_ACCOUNTS', isArray, list: [] };

  const accounts = list.map((acc, index) => {
    const source = isArray ? `GENSHIN_ACCOUNTS[${index + 1}]` : 'GENSHIN_ACCOUNTS';
    const overrideKey = `GENSHIN_ACCOUNTS_${index + 1}`;
    const normalized = normalizeAccount(
      applyLtokenOverride(acc, overrideKey),
      index,
      source,
      'GENSHIN_ACCOUNTS'
    );
    group.list.push(normalized);
    return normalized;
  });

  if (secretGroups && typeof secretGroups.set === 'function') {
    secretGroups.set('GENSHIN_ACCOUNTS', group);
  }
  return accounts;
}

/**
 * Membaca seluruh akun dari Environment Secrets (mendukung legacy & split)
 */
export function loadAccounts(secretGroups = null) {
  const legacyAccounts = loadLegacyAccountsSecret(secretGroups);
  const splitAccounts = loadSplitAccountSecrets(secretGroups);
  const accounts = [...legacyAccounts, ...splitAccounts];

  if (accounts.length === 0) {
    throw new Error('Isi minimal 1 akun lewat GENSHIN_ACCOUNTS atau GENSHIN_ACCOUNT_1.');
  }

  return accounts;
}

/**
 * Membaca daftar kode promo dari argumen CLI atau file promo-codes.json
 */
export function loadPromoCodes(customFileUrl = DEFAULT_PROMO_FILE, cliArgs = process.argv.slice(2)) {
  const cliCodes = (cliArgs || []).filter(Boolean);
  if (cliCodes.length > 0) {
    return cliCodes;
  }

  if (existsSync(customFileUrl)) {
    try {
      const parsed = JSON.parse(readFileSync(customFileUrl, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed.filter((c) => c.status && c.kode).map((c) => c.kode);
      }
    } catch {
      // Abaikan error parse
    }
  }

  return [];
}

/**
 * Memecah string pesan panjang agar tidak melebihi batasan panjang Telegram API
 */
export function splitMessage(text, limit = 3900) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Mengirim pesan ke Telegram Bot dengan pembagian chunk otomatis
 */
export async function sendTelegramMessage(botToken, chatId, text, limit = 3900) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  for (const chunk of splitMessage(text, limit)) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gagal kirim pesan Telegram: HTTP ${response.status} ${body}`);
    }
  }
}
