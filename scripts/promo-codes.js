import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { load } from 'cheerio';
import { getRandomUserAgent } from './user-agents.js';
import {
  findUserGameRole,
  redeemCode,
  loadAccounts,
  getRequiredEnv,
  getWibTime,
  sendTelegramMessage,
  delay,
} from './hoyolab-api.js';

const GAME8_URL = 'https://game8.co/games/Genshin-Impact/archives/304759';
const PAGE_URL = 'https://genshin-impact.fandom.com/wiki/Promotional_Code';
const API_URL =
  'https://genshin-impact.fandom.com/api.php?action=parse&page=Promotional_Code&format=json&prop=text';
const DATA_FILE = new URL('../promo-codes.json', import.meta.url);

const client = wrapper(axios.create({
  jar: new CookieJar(),
  withCredentials: true,
  timeout: 30000,
}));

function formatDate(str) {
  const d = new Date(`${str} UTC`);
  if (isNaN(d)) return null;
  return (
    `${String(d.getUTCDate()).padStart(2, '0')}/` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}/` +
    d.getUTCFullYear()
  );
}

function formatGame8Date(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const month = m[1].padStart(2, '0');
  const day = m[2].padStart(2, '0');
  const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : new Date().getFullYear();
  return `${day}/${month}/${year}`;
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

function getHeaders(referer = 'https://game8.co/') {
  return {
    'User-Agent': getRandomUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
  };
}

async function getWithRetry(url, attempts = 3) {
  let lastError;
  const referer = url.includes('game8.co')
    ? 'https://game8.co/'
    : 'https://genshin-impact.fandom.com/';

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.get(url, { headers: getHeaders(referer) });
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
  }
  throw lastError;
}

async function scrapeFromGame8(html) {
  const $ = load(html);
  const codes = [];

  $('table.a-table').each((_, tbl) => {
    const headerText = $(tbl)
      .find('th')
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get()
      .join(' ');
    const prevHeader = $(tbl)
      .prevAll('h2, h3, h4')
      .first()
      .text()
      .trim()
      .toLowerCase();

    // Abaikan tabel kode kedaluwarsa
    if (prevHeader.includes('expired') || headerText.includes('expired')) {
      return;
    }

    const isGlobalExclusive =
      prevHeader.includes('global-exclusive') ||
      headerText.includes('global codes');
    const isLatestRedeem =
      prevHeader.includes('latest redeem codes') ||
      (headerText.includes('redeem codes') && !headerText.includes('expired'));

    if (!isGlobalExclusive && !isLatestRedeem) {
      return;
    }

    // Deteksi tanggal expired livestream / special program jika tercantum
    let livestreamExpiry = null;
    if (isGlobalExclusive) {
      const prevParagraphs = $(tbl).prevAll('p').text();
      const match = prevParagraphs.match(
        /(?:after|until)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
      );
      if (match) {
        livestreamExpiry = formatDate(match[1]);
      }
    }

    $(tbl)
      .find('tr')
      .each((_, tr) => {
        const firstCol = $(tr).find('td').first();
        const secondCol = $(tr).find('td').eq(1);
        if (!firstCol.length || !secondCol.length) return;

        // Ambil kode dari value input copy, tautan Hoyoverse redeem gift, atau teks
        let kode = firstCol.find('input.a-clipboard__textInput').val()?.trim();
        if (!kode) {
          const link = firstCol.find('a[href*="code="]').attr('href');
          if (link) {
            const m = link.match(/[?&]code=([A-Za-z0-9]+)/);
            if (m) kode = m[1];
          }
        }
        if (!kode) {
          const m = firstCol.text().match(/([A-Z0-9]{4,30})/i);
          if (m) kode = m[1];
        }

        if (!kode || !/^[A-Z0-9]{4,30}$/i.test(kode)) return;

        // Ambil data reward
        const rewards = [];
        secondCol.find('.align').each((_, div) => {
          const text = $(div).text().replace(/\s+/g, ' ').trim();
          if (text) rewards.push(text);
        });
        if (rewards.length === 0) {
          const text = secondCol.text().replace(/\s+/g, ' ').trim();
          if (text) rewards.push(text);
        }

        // Tanggal rilis (Date Added: MM/DD)
        const dateMatch = firstCol
          .text()
          .match(/Date Added\s*:\s*(\d{1,2}\/\d{1,2})/i);
        const release = dateMatch ? formatGame8Date(dateMatch[1]) : null;

        const expired = livestreamExpiry;
        const status = getStatus(expired);

        codes.push({
          kode,
          support_server: ['America', 'Europe', 'Asia', 'TW/HK/Macao'],
          reward: rewards,
          release,
          expired,
          status,
        });
      });
  });

  const uniqueMap = new Map();
  for (const item of codes) {
    if (!uniqueMap.has(item.kode)) {
      uniqueMap.set(item.kode, item);
    }
  }
  return Array.from(uniqueMap.values());
}

async function scrapeViaGame8() {
  const { data } = await getWithRetry(GAME8_URL);
  if (!data || typeof data !== 'string') {
    throw new Error('Respons Game8 kosong.');
  }
  const codes = await scrapeFromGame8(data);
  if (!codes || codes.length === 0) {
    throw new Error('Tidak ada kode yang ditemukan di Game8.');
  }
  return codes;
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
    console.log('Mencoba mengambil kode promo dari Game8 (Primary)...');
    return await scrapeViaGame8();
  } catch (game8Error) {
    console.warn(
      `Gagal mengambil dari Game8 (${game8Error.message}), fallback ke Fandom API...`
    );
    try {
      return await scrapeViaApi();
    } catch {
      console.warn('Gagal mengambil dari Fandom API, fallback ke Fandom Page...');
      return await scrapeViaPage();
    }
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
  const savedCodesMap = new Map(savedCodes.map((c) => [c.kode, c]));
  const savedKode = new Set(savedCodes.map((code) => code.kode));

  const merged = currentCodes.map((code) => {
    const existing = savedCodesMap.get(code.kode);
    return existing
      ? { ...existing, ...code, first_seen: existing.first_seen || now }
      : { ...code, first_seen: now };
  });

  // Pertahankan riwayat kode lama di promo-codes.json agar tidak terhapus
  for (const saved of savedCodes) {
    if (!merged.some((c) => c.kode === saved.kode)) {
      merged.push(saved);
    }
  }

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
