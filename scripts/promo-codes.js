import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { load } from 'cheerio';
import { getRandomUserAgent } from './user-agents.js';
import { findUserGameRole, redeemCode, loadAccounts } from './hoyolab-api.js';

const TELEGRAM_LIMIT = 3900;
const PAGE_URL = 'https://genshin-impact.fandom.com/wiki/Promotional_Code';
const API_URL =
  'https://genshin-impact.fandom.com/api.php?action=parse&page=Promotional_Code&format=json&prop=text';
const DATA_FILE = new URL('../promo-codes.json', import.meta.url);

const client = wrapper(axios.create({
  jar: new CookieJar(),
  withCredentials: true,
  timeout: 30000,
}));

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

function formatDate(str) {
  const d = new Date(`${str} UTC`);
  if (isNaN(d)) return null;
  return (
    `${String(d.getUTCDate()).padStart(2, '0')}/` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}/` +
    d.getUTCFullYear()
  );
}

function getDate(text, type) {
  const key = type === 'release' ? 'Discovered' : 'Valid until';
  const match = text.match(
    new RegExp(`${key}:\\s*([A-Za-z]+\\s+\\d{1,2},\\s+\\d{4})`, 'i')
  );
  return match ? formatDate(match[1]) : null;
}

function getStatus(date) {
  if (!date) return true;
  const [d, m, y] = date.split('/').map(Number);
  return new Date() <= new Date(y, m - 1, d, 23, 59, 59);
}

function getHeaders() {
  return {
    'User-Agent': getRandomUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://genshin-impact.fandom.com/',
  };
}

async function getWithRetry(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.get(url, { headers: getHeaders() });
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
  }
  throw lastError;
}

async function scrapeFromHtml(html) {
  const $ = load(html);
  const codes = [];

  $('table.wikitable tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const kode = $(cells[0]).text().replace(/\s+/g, '').trim();
    if (!/^[A-Z0-9]{6,30}$/i.test(kode)) return;

    const support_server = $(cells[1])
      .text()
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    const reward = $(cells[2])
      .find('.item-text')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get();

    if (!reward.length) {
      const text = $(cells[2]).text().replace(/\s+/g, ' ').trim();
      if (text) reward.push(text);
    }

    const date = $(cells[3]).text().replace(/\s+/g, ' ').trim();
    const expired = getDate(date, 'expired');

    codes.push({
      kode,
      support_server,
      reward,
      release: getDate(date, 'release'),
      expired,
      status: getStatus(expired),
    });
  });

  return codes;
}

async function scrapeViaApi() {
  const { data } = await getWithRetry(API_URL);
  const html = data?.parse?.text?.['*'];
  if (!html) {
    throw new Error('Respons API fandom tidak memiliki konten halaman.');
  }
  return scrapeFromHtml(html);
}

async function scrapeViaPage() {
  const { data } = await getWithRetry(PAGE_URL);
  return scrapeFromHtml(data);
}

async function scrapeCodes() {
  try {
    return await scrapeViaApi();
  } catch {
    return scrapeViaPage();
  }
}

function loadSavedCodes() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCodes(codes) {
  writeFileSync(DATA_FILE, `${JSON.stringify(codes, null, 2)}\n`, 'utf8');
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
  const botToken = getRequiredEnv('BOT_TOKEN');
  const chatId = getRequiredEnv('TELEGRAM_CHAT_ID');
  const now = getWibTime();

  const isManualRun =
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
    process.argv.includes('--force') ||
    process.argv.includes('--redeem-all');

  const currentCodes = await scrapeCodes();
  const savedCodes = loadSavedCodes();
  const savedKode = new Set(savedCodes.map((code) => code.kode));

  const merged = currentCodes.map((code) =>
    savedKode.has(code.kode) ? code : { ...code, first_seen: now }
  );
  saveCodes(merged);

  const newCodes = merged.filter(
    (code) => code.status && !savedKode.has(code.kode)
  );

  // Jika bukan manual run dan tidak ada kode baru, berhenti agar tidak spam Telegram tiap interval cron
  if (!isManualRun && newCodes.length === 0) {
    console.log('Tidak ada kode promo baru.');
    return;
  }

  // Jika ada kode baru, prioritaskan kode baru. Jika manual run dan tidak ada kode baru, redeem semua kode aktif.
  const targetCodes = newCodes.length > 0 ? newCodes : currentCodes.filter((c) => c.status);

  if (targetCodes.length === 0) {
    console.log('Tidak ada kode promo aktif untuk diproses.');
    return;
  }

  const isNew = newCodes.length > 0;
  const lines = [
    isNew ? 'Kode Promo Genshin Impact Baru' : 'Sinkronisasi Kode Promo Genshin Impact (Manual Run)',
    `Waktu: ${now} WIB`,
    `Total kode: ${targetCodes.length} (${isNew ? 'Kode Baru' : 'Kode Aktif'})`,
    '',
  ];

  targetCodes.forEach((code, index) => {
    lines.push(
      `${index + 1}. Kode: ${code.kode}`,
      `   Reward: ${code.reward.join(', ') || '-'}`,
      `   Server: ${code.support_server.join(', ') || '-'}`,
      `   Berlaku sampai: ${code.expired || 'Indefinite'}`,
      ''
    );
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let accounts = [];
  try {
    accounts = loadAccounts();
  } catch (accError) {
    console.log(`Info akun: ${accError.message}`);
  }

  if (accounts.length > 0) {
    console.log(`\nMemproses ${targetCodes.length} kode untuk ${accounts.length} akun secara paralel...`);
    lines.push('--- Status Redeem Akun ---');

    // Eksekusi paralel per akun dengan staggered start 300ms agar request tidak menumpuk dalam 1 milidetik
    const accountResults = await Promise.all(
      accounts.map(async (account, accountIndex) => {
        if (accountIndex > 0) {
          await delay(accountIndex * 300);
        }

        console.log(`[Start Akun ${accountIndex + 1}/${accounts.length}] ${account.name}`);
        const roleInfo = await findUserGameRole(account);

        if (!roleInfo.found) {
          console.error(`- [Akun ${accountIndex + 1}] ${account.name}: ${roleInfo.message}`);
          return {
            accountIndex,
            account,
            roleInfo: null,
            lines: [`${accountIndex + 1}. ${account.name}: GAGAL (${roleInfo.message})`],
          };
        }

        const accountLines = [
          `${accountIndex + 1}. ${account.name} - ${roleInfo.nickname} (UID: ${roleInfo.uid})`,
          `   Server: ${roleInfo.regionName}`,
        ];

        for (const targetCode of targetCodes) {
          const startTime = Date.now();
          try {
            const res = await redeemCode({
              accountOrLtoken: account,
              uid: roleInfo.uid,
              region: roleInfo.region,
              cdkey: targetCode.kode,
            });

            const status = res.success
              ? 'BERHASIL'
              : res.isAlreadyClaimed
              ? 'SUDAH DIKLAIM'
              : res.isLimitReached
              ? 'LIMIT HABIS'
              : 'GAGAL';

            console.log(`  * [Akun ${accountIndex + 1}][${targetCode.kode}] ${status} -> ${res.message}`);
            accountLines.push(`   * ${targetCode.kode}: ${status} (${res.message})`);
          } catch (err) {
            console.error(`  * [Akun ${accountIndex + 1}][${targetCode.kode}] ERROR: ${err.message}`);
            accountLines.push(`   * ${targetCode.kode}: ERROR (${err.message})`);
          }

          // Pastikan jeda per akun minimal 5.5 detik antar kode
          const elapsed = Date.now() - startTime;
          const waitTime = Math.max(0, 5500 - elapsed);
          await delay(waitTime);
        }

        return {
          accountIndex,
          account,
          roleInfo,
          lines: accountLines,
        };
      })
    );

    // Urutkan kembali sesuai urutan akun semula agar laporan Telegram rapi
    accountResults.sort((a, b) => a.accountIndex - b.accountIndex);
    for (const result of accountResults) {
      lines.push(...result.lines, '');
    }
  }

  await sendTelegramMessage(botToken, chatId, lines.join('\n'));
  console.log(`Ditemukan ${newCodes.length} kode promo baru.`);
}

main().catch(async (error) => {
  console.error(error.message);

  const botToken = process.env.BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) {
    try {
      await sendTelegramMessage(
        botToken,
        chatId,
        `Pemantauan kode promo Genshin gagal dijalankan.\nPesan: ${error.message}`
      );
    } catch (telegramError) {
      console.error(telegramError.message);
    }
  }

  process.exit(1);
});
