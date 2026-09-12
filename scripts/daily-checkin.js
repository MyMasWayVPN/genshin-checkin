import { Client } from 'genshin-kit.js';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getRandomUserAgent } from './user-agents.js';

// Intercept RequestManager dari genshin-kit.js agar merotasi User-Agent di setiap request
const require = createRequire(import.meta.url);
const { RequestManager } = require('genshin-kit.js/dist/utils/request.js');

const originalGet = RequestManager.prototype.get;
RequestManager.prototype.get = function (url, headers, params) {
  this.headers = {
    ...this.headers,
    'User-Agent': getRandomUserAgent(),
  };
  return originalGet.call(this, url, headers, params);
};

const originalPost = RequestManager.prototype.post;
RequestManager.prototype.post = function (url, headers, data, params) {
  this.headers = {
    ...this.headers,
    'User-Agent': getRandomUserAgent(),
  };
  return originalPost.call(this, url, headers, data, params);
};

const TELEGRAM_LIMIT = 3900;
const LOG_FILE = new URL('../log.txt', import.meta.url);

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Secret ${name} belum diisi.`);
  }
  return value;
}

function getWibTime() {
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

function parseJson(value, secretName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Secret ${secretName} harus berupa JSON valid. ${error.message}`);
  }
}

function normalizeAccount(account, index, source, secretName) {
  const name = account?.name?.trim() || `Akun ${index + 1}`;
  const ltuid = String(account?.ltuid || account?.luid || account?.ltuid_v2 || '').trim();
  const ltoken = String(account?.ltoken || account?.ltoken_v2 || '').trim();

  if (!ltuid || !ltoken) {
    throw new Error(`Data akun ke-${index + 1} (${source}) harus punya ltuid/luid dan ltoken.`);
  }

  const rawObject = {
    name,
    ltuid,
    ltoken,
  };

  return {
    ...account,
    name,
    ltuid,
    ltoken,
    source,
    secretName,
    rawObject,
  };
}

function getLtokenOverride(secretName) {
  return process.env[`${secretName}_LTOKEN`]?.trim();
}

function applyLtokenOverride(account, secretName) {
  const overrideLtoken = getLtokenOverride(secretName);
  if (overrideLtoken && typeof account === 'object' && account !== null) {
    account.ltoken = overrideLtoken;
  }
  return account;
}

function loadSplitAccountSecrets(secretGroups) {
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

      if (secretGroups) {
        secretGroups.set(item.secretName, group);
      }
      return accounts;
    });
}

function loadLegacyAccountsSecret(secretGroups) {
  const rawAccounts = process.env.GENSHIN_ACCOUNTS?.trim();
  if (!rawAccounts) {
    return [];
  }

  const parsed = parseJson(rawAccounts, 'GENSHIN_ACCOUNTS');
  const isArray = Array.isArray(parsed);
  const list = isArray ? parsed : [parsed];

  const group = { secretName: 'GENSHIN_ACCOUNTS', isArray, list: [] };

  const accounts = list.map((account, index) => {
    const source = isArray ? `GENSHIN_ACCOUNTS[${index + 1}]` : 'GENSHIN_ACCOUNTS';
    const overrideKey = `GENSHIN_ACCOUNTS_${index + 1}`;
    const normalized = normalizeAccount(
      applyLtokenOverride(account, overrideKey),
      index,
      source,
      'GENSHIN_ACCOUNTS'
    );
    group.list.push(normalized);
    return normalized;
  });

  if (secretGroups) {
    secretGroups.set('GENSHIN_ACCOUNTS', group);
  }
  return accounts;
}

function loadAccounts() {
  const secretGroups = new Map();
  const legacyAccounts = loadLegacyAccountsSecret(secretGroups);
  const splitAccounts = loadSplitAccountSecrets(secretGroups);
  const accounts = [...legacyAccounts, ...splitAccounts];

  if (accounts.length === 0) {
    throw new Error('Isi minimal 1 akun lewat GENSHIN_ACCOUNTS atau GENSHIN_ACCOUNT_1.');
  }

  accounts.secretGroups = secretGroups;
  return accounts;
}

async function checkIn(account) {
  const client = new Client();
  client.login(account.ltuid, account.ltoken);

  if (!client.dailyReward?.checkIn) {
    throw new Error('Fitur dailyReward.checkIn tidak tersedia dari genshin-kit.js.');
  }

  const result = await client.dailyReward.checkIn({});
  const status = result?.status || result?.message || result?.retmsg || JSON.stringify(result);

  let detail = status || 'Tidak ada detail.';
  try {
    const cookie = client.cookieManager.get().cookie;
    const rewardInfo = await client.dailyReward.rewardInfo.fetch({ cookie });
    if (rewardInfo) {
      detail += ` | Total login: ${rewardInfo.total_sign_day ?? '-'} | Hari ini: ${rewardInfo.today ?? '-'}`;
    }
  } catch {
    // Detail reward tidak wajib. Check-in utama tetap dianggap memakai hasil checkIn().
  }

  return detail;
}

function isFailure(message) {
  return /error|failed|fail|gagal|captcha|verify|verifikasi/i.test(String(message));
}

function isTokenDead(message) {
  return /not logged in|login expired|login status is invalid|authkey|token expired|tidak ditemukan karakter|cannot find character/i.test(String(message));
}

function updateGithubSecret(secretName, content) {
  const token = process.env.GH_PAT?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim();

  if (!token || !repo) {
    return { updated: false, reason: 'Secret GH_PAT belum diset' };
  }

  try {
    execSync(`gh secret set "${secretName}" --repo "${repo}"`, {
      input: content,
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { updated: true };
  } catch (err) {
    return { updated: false, reason: err.stderr?.toString()?.trim() || err.message };
  }
}

async function deleteGithubSecret(secretName) {
  const token = process.env.GH_PAT?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim();

  if (!token || !repo) {
    return { deleted: false, reason: 'Secret GH_PAT belum diset (hapus manual di GitHub Settings)' };
  }

  // 1. Coba lewat gh CLI
  try {
    execSync(`gh secret delete "${secretName}" --repo "${repo}"`, {
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { deleted: true };
  } catch {
    // 2. Fallback ke GitHub REST API jika gh CLI tidak tersedia
    try {
      const url = `https://api.github.com/repos/${repo}/actions/secrets/${secretName}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Genshin-Checkin-Bot',
        },
      });

      if (res.status === 204) {
        return { deleted: true };
      }
      const body = await res.text();
      return { deleted: false, reason: `HTTP ${res.status}: ${body}` };
    } catch (err) {
      return { deleted: false, reason: err.message };
    }
  }
}

function getLogAccountName(account, index) {
  const name = account.name.includes('@') ? `Akun ${index + 1}` : account.name;
  return `${name} (${account.source})`;
}

function splitMessage(text) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > TELEGRAM_LIMIT) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function writeLog(lines) {
  const logEntry = [
    '==================================================',
    ...lines,
    '',
  ].join('\n');

  writeFileSync(LOG_FILE, `${logEntry}\n`, 'utf8');
}

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  for (const chunk of splitMessage(text)) {
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

async function main() {
  const botToken = getRequiredEnv('BOT_TOKEN');
  const chatId = getRequiredEnv('TELEGRAM_CHAT_ID');
  const accounts = loadAccounts();

  const lines = [
    'Daily Check-in Genshin',
    `Waktu: ${getWibTime()} WIB`,
    `Total akun: ${accounts.length}`,
    '',
  ];
  const logLines = [...lines];

  let successCount = 0;
  let failedCount = 0;
  const deadAccounts = [];

  for (const [index, account] of accounts.entries()) {
    try {
      const detail = await checkIn(account);
      const failed = isFailure(detail);

      if (failed) {
        failedCount += 1;
        if (isTokenDead(detail)) {
          deadAccounts.push({ account, reason: detail });
        }
      } else {
        successCount += 1;
      }

      lines.push(
        `${index + 1}. ${account.name} (${account.source})`,
        `Status: ${failed ? 'GAGAL' : 'BERHASIL'}`,
        `Pesan: ${detail}`,
        ''
      );
      logLines.push(
        `${index + 1}. ${getLogAccountName(account, index)}`,
        `Status: ${failed ? 'GAGAL' : 'BERHASIL'}`,
        `Pesan: ${detail}`,
        ''
      );
    } catch (error) {
      failedCount += 1;
      if (isTokenDead(error.message)) {
        deadAccounts.push({ account, reason: error.message });
      }

      lines.push(
        `${index + 1}. ${account.name} (${account.source})`,
        'Status: GAGAL',
        `Pesan: ${error.message}`,
        ''
      );
      logLines.push(
        `${index + 1}. ${getLogAccountName(account, index)}`,
        'Status: GAGAL',
        `Pesan: ${error.message}`,
        ''
      );
    }
  }

  lines.push(`Berhasil: ${successCount}`);
  lines.push(`Gagal: ${failedCount}`);
  logLines.push(`Berhasil: ${successCount}`);
  logLines.push(`Gagal: ${failedCount}`);

  // Laporkan & hapus / perbarui akun tidak valid atau token mati jika ada
  if (deadAccounts.length > 0) {
    lines.push('', '⚠️ PERINGATAN: AKUN TIDAK VALID / EXPIRED:');
    const deadLtuidSet = new Set(deadAccounts.map((d) => d.account.ltuid));

    // 1. Rincian status per akun yang mati
    for (const dead of deadAccounts) {
      lines.push(
        `- ${dead.account.name} (${dead.account.source})`,
        `  Masalah: ${dead.reason}`,
        ''
      );
    }

    // 2. Pembersihan per secret (array difilter & diperbarui, single secret dihapus)
    const secretGroups = accounts.secretGroups || new Map();
    for (const [secretName, group] of secretGroups.entries()) {
      const deadInGroup = group.list.filter((acc) => deadLtuidSet.has(acc.ltuid));
      if (deadInGroup.length === 0) continue;

      const activeInGroup = group.list.filter((acc) => !deadLtuidSet.has(acc.ltuid));

      if (activeInGroup.length === 0) {
        // Semua akun di secret ini mati -> Hapus Secret
        lines.push(`📌 Secret "${secretName}": Semua akun sudah tidak aktif.`);
        const delRes = await deleteGithubSecret(secretName);
        if (delRes.deleted) {
          lines.push(`  Status: ✅ Secret "${secretName}" BERHASIL dihapus otomatis dari GitHub!`);
          console.log(`[Auto-Delete] Secret ${secretName} berhasil dihapus dari GitHub Secrets.`);
        } else {
          lines.push(`  Status: ⚠️ Gagal hapus otomatis (${delRes.reason}). Harap hapus manual.`);
        }
      } else {
        // Masih ada akun aktif di dalam array / secret ini -> UPDATE Secret
        const cleanPayload = group.isArray
          ? activeInGroup.map((a) => a.rawObject)
          : activeInGroup[0].rawObject;
        const cleanJson = JSON.stringify(cleanPayload, null, 2);

        lines.push(
          `📌 Secret "${secretName}": ${deadInGroup.length} akun mati dibuang, tersisa ${activeInGroup.length} akun aktif.`
        );

        const updateRes = updateGithubSecret(secretName, cleanJson);
        if (updateRes.updated) {
          lines.push(`  Status: ✅ Secret "${secretName}" BERHASIL diperbarui otomatis di GitHub!`);
          console.log(`[Auto-Update] Secret ${secretName} berhasil diperbarui di GitHub Secrets.`);
        } else {
          lines.push(`  Status: ⚠️ Gagal update otomatis (${updateRes.reason}).`);
        }

        lines.push(
          '',
          `📋 JSON bersih siap pakai untuk Secret "${secretName}":`,
          '```json',
          cleanJson,
          '```'
        );
      }
      lines.push('');
    }
  }

  writeLog(logLines);

  await sendTelegramMessage(botToken, chatId, lines.join('\n'));

  // Hanya set exit code 1 jika SEMUA akun gagal.
  // Jika hanya sebagian akun yang gagal, job GitHub Actions tetap hijau (sukses)
  // karena rincian akun mati sudah lengkap dilaporkan ke Telegram.
  if (accounts.length > 0 && failedCount === accounts.length) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error.message);

  writeLog([
    'Daily Check-in Genshin',
    `Waktu: ${getWibTime()} WIB`,
    'Status: GAGAL',
    `Pesan: ${error.message}`,
  ]);

  const botToken = process.env.BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) {
    try {
      await sendTelegramMessage(botToken, chatId, `Daily Check-in Genshin gagal dijalankan.\nPesan: ${error.message}`);
    } catch (telegramError) {
      console.error(telegramError.message);
    }
  }

  process.exit(1);
});
