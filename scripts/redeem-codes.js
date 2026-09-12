import { existsSync, readFileSync } from 'node:fs';
import {
  verifyLToken,
  findUserGameRole,
  redeemCode,
} from './hoyolab-api.js';

const TELEGRAM_LIMIT = 3900;
const DATA_FILE = new URL('../promo-codes.json', import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function normalizeAccount(account, index, source) {
  const name = account?.name?.trim() || `Akun ${index + 1}`;
  const ltuid = String(account?.ltuid || account?.luid || account?.ltuid_v2 || '').trim();
  const ltoken = String(account?.ltoken || account?.ltoken_v2 || '').trim();

  if (!ltuid || !ltoken) {
    throw new Error(`Data akun ke-${index + 1} (${source}) harus punya ltuid/luid dan ltoken.`);
  }

  return { name, ltuid, ltoken, source };
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

function loadSplitAccountSecrets() {
  return Object.entries(process.env)
    .map(([key, value]) => {
      const match = key.match(/^GENSHIN_ACCOUNT_(\d+)$/);
      return match && value?.trim()
        ? { index: Number(match[1]), value: value.trim(), secretName: key }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((item, index) =>
      normalizeAccount(applyLtokenOverride(parseJson(item.value, item.secretName), item.secretName), index, item.secretName)
    );
}

function loadLegacyAccountsSecret() {
  const rawAccounts = process.env.GENSHIN_ACCOUNTS?.trim();
  if (!rawAccounts) {
    return [];
  }

  const accounts = parseJson(rawAccounts, 'GENSHIN_ACCOUNTS');
  if (!Array.isArray(accounts)) {
    throw new Error('Secret GENSHIN_ACCOUNTS harus berupa array.');
  }

  return accounts.map((account, index) => {
    const source = `GENSHIN_ACCOUNTS[${index + 1}]`;
    const overrideKey = `GENSHIN_ACCOUNTS_${index + 1}`;
    return normalizeAccount(applyLtokenOverride(account, overrideKey), index, source);
  });
}

function loadAccounts() {
  const legacyAccounts = loadLegacyAccountsSecret();
  const splitAccounts = loadSplitAccountSecrets();
  const accounts = [...legacyAccounts, ...splitAccounts];

  if (accounts.length === 0) {
    throw new Error('Isi minimal 1 akun lewat GENSHIN_ACCOUNTS atau GENSHIN_ACCOUNT_1.');
  }

  return accounts;
}

function loadPromoCodes() {
  // Ambil dari argument CLI jika ada: node scripts/redeem-codes.js CODE1 CODE2
  const cliCodes = process.argv.slice(2).filter(Boolean);
  if (cliCodes.length > 0) {
    return cliCodes;
  }

  // Fallback: baca dari promo-codes.json yang masih aktif
  if (existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed.filter((c) => c.status && c.kode).map((c) => c.kode);
      }
    } catch {
      // Abaikan error parse
    }
  }

  return [];
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
  const now = getWibTime();
  const accounts = loadAccounts();
  const codes = loadPromoCodes();

  console.log(`[${now} WIB] Memulai proses redeem code...`);
  console.log(`Total akun terdeteksi: ${accounts.length}`);
  console.log(`Total kode promo yang akan ditukar: ${codes.length}`);

  if (codes.length === 0) {
    console.log('Tidak ada kode promo untuk di-redeem.');
    return;
  }

  const lines = [
    'Redeem Promo Code Genshin Impact',
    `Waktu: ${now} WIB`,
    `Total Akun: ${accounts.length}`,
    `Kode: ${codes.join(', ')}`,
    '',
  ];

  for (const [accountIndex, account] of accounts.entries()) {
    console.log(`\n[Akun ${accountIndex + 1}/${accounts.length}] ${account.name} (${account.source})`);

    // 1. Verifikasi LToken terlebih dahulu
    const verify = await verifyLToken(account);
    if (!verify.valid) {
      const failMsg = `LToken tidak valid: ${verify.message}`;
      console.error(`- ${failMsg}`);
      lines.push(`${accountIndex + 1}. ${account.name}`, `Status: GAGAL - ${failMsg}`, '');
      continue;
    }

    // 2. Deteksi otomatis Region & UID Game
    const roleInfo = await findUserGameRole(account);
    if (!roleInfo.found) {
      console.error(`- ${roleInfo.message}`);
      lines.push(`${accountIndex + 1}. ${account.name}`, `Status: GAGAL - ${roleInfo.message}`, '');
      continue;
    }

    console.log(`- Karakter: ${roleInfo.nickname} (Lv. ${roleInfo.level}) | UID: ${roleInfo.uid} | Region: ${roleInfo.regionName}`);
    lines.push(
      `${accountIndex + 1}. ${account.name} - ${roleInfo.nickname} (UID: ${roleInfo.uid})`,
      `Server: ${roleInfo.regionName}`
    );

    // 3. Redeem setiap promo code
    for (const cdkey of codes) {
      try {
        const result = await redeemCode({
          accountOrLtoken: account,
          uid: roleInfo.uid,
          region: roleInfo.region,
          cdkey,
        });

        const statusLabel = result.success
          ? 'BERHASIL'
          : result.isAlreadyClaimed
          ? 'SUDAH DIKLAIM'
          : result.isLimitReached
          ? 'LIMIT HABIS'
          : 'GAGAL';

        console.log(`  * [${cdkey}] ${statusLabel} -> ${result.message}`);
        lines.push(`  * ${cdkey}: ${statusLabel} (${result.message})`);
      } catch (err) {
        console.error(`  * [${cdkey}] ERROR -> ${err.message}`);
        lines.push(`  * ${cdkey}: ERROR (${err.message})`);
      }

      // Beri jeda 4 detik untuk menghindari rate limit API HoYoverse
      await delay(4000);
    }
    lines.push('');
  }

  // Kirim notifikasi Telegram jika botToken & chatId ada di env
  const botToken = process.env.BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) {
    try {
      await sendTelegramMessage(botToken, chatId, lines.join('\n'));
      console.log('\nLaporan hasil redeem berhasil dikirim ke Telegram.');
    } catch (telegramErr) {
      console.error('\nGagal mengirim laporan ke Telegram:', telegramErr.message);
    }
  }

  console.log('\nProses redeem selesai.');
}

main().catch((error) => {
  console.error('Fatal error saat redeem codes:', error.message);
  process.exit(1);
});
