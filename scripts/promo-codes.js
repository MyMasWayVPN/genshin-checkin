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
  const isGame8 = referer.includes('game8.co');
  if (isGame8) {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      Referer: 'https://game8.co/',
    };
  }

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

  // Strategi 1: Scan setiap input copy kode di tabel aktif
  $('input.a-clipboard__textInput').each((_, inputEl) => {
    let kode = $(inputEl).val()?.trim();
    if (!kode || !/^[A-Z0-9]{4,30}$/i.test(kode)) return;

    const tr = $(inputEl).closest('tr');
    const table = $(inputEl).closest('table');

    const firstHeaderBeforeTable = table.prevAll('h2, h3, h4').first().text().toLowerCase();
    const tableHeaderText = table.find('th').text().toLowerCase();

    // Abaikan jika tabel masuk kategori expired
    if (firstHeaderBeforeTable.includes('expired') || tableHeaderText.includes('expired')) {
      return;
    }

    // Ambil reward
    const secondCol = tr.find('td').eq(1);
    const rewards = [];
    if (secondCol.length) {
      secondCol.find('.align').each((_, div) => {
        const text = $(div).text().replace(/\s+/g, ' ').trim();
        if (text) rewards.push(text);
      });
      if (rewards.length === 0) {
        const text = secondCol.text().replace(/\s+/g, ' ').trim();
        if (text) rewards.push(text);
      }
    }

    // Tanggal rilis
    const firstCol = tr.find('td').first();
    const dateMatch = (firstCol.length ? firstCol.text() : tr.text()).match(
      /Date Added\s*:\s*(\d{1,2}\/\d{1,2})/i
    );
    const release = dateMatch ? formatGame8Date(dateMatch[1]) : null;

    // HANYA tabel Livestream / Global Codes yang memiliki expiry livestream
    let expired = null;
    const isLivestream =
      firstHeaderBeforeTable.includes('global-exclusive') ||
      firstHeaderBeforeTable.includes('livestream') ||
      tableHeaderText.includes('global codes');

    if (isLivestream) {
      const prevParagraphs = table.prevAll('p').first().text();
      const match = prevParagraphs.match(
        /(?:after|until)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
      );
      if (match) {
        expired = formatDate(match[1]);
      }
    }

    const status = getStatus(expired);

    codes.push({
      kode,
      support_server: ['America', 'Europe', 'Asia', 'TW/HK/Macao'],
      reward: rewards,
      release,
      expired,
      status,
      source: 'Game8',
    });
  });

  // Strategi 2: Fallback jika input.a-clipboard__textInput tidak ditemukan
  if (codes.length === 0) {
    $('a[href*="gift?code="]').each((_, linkEl) => {
      const href = $(linkEl).attr('href') || '';
      const m = href.match(/[?&]code=([A-Za-z0-9]+)/);
      if (!m) return;
      const kode = m[1].trim();
      if (!/^[A-Z0-9]{4,30}$/i.test(kode)) return;

      const tr = $(linkEl).closest('tr');
      const secondCol = tr.find('td').eq(1);
      const rewards = [];
      if (secondCol.length) {
        secondCol.find('.align').each((_, div) => {
          const text = $(div).text().replace(/\s+/g, ' ').trim();
          if (text) rewards.push(text);
        });
      }

      codes.push({
        kode,
        support_server: ['America', 'Europe', 'Asia', 'TW/HK/Macao'],
        reward: rewards,
        release: null,
        expired: null,
        status: true,
        source: 'Game8',
      });
    });
  }

  const uniqueMap = new Map();
  for (const item of codes) {
    if (!uniqueMap.has(item.kode)) {
      uniqueMap.set(item.kode, item);
    }
  }
  return Array.from(uniqueMap.values());
}

function scrapeFromGame8Markdown(markdown) {
  const codes = [];
  const lines = markdown.split('\n');

  let currentSection = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      currentSection = trimmed.toLowerCase();
    }

    // Abaikan jika sudah masuk section expired
    if (currentSection.includes('expired')) {
      continue;
    }

    // Target section: Global-Exclusive Codes atau Latest Redeem Codes
    const isTargetSection =
      currentSection.includes('global-exclusive') ||
      currentSection.includes('latest redeem') ||
      currentSection.includes('genshin impact codes') ||
      currentSection.includes('special program');

    if (!isTargetSection) continue;

    const codeMatch = trimmed.match(/gift\?code=([A-Za-z0-9]+)/);
    if (!codeMatch) continue;

    const kode = codeMatch[1].trim();
    if (!/^[A-Z0-9]{4,30}$/i.test(kode)) continue;

    const dateMatch = trimmed.match(/Date Added\*?\*?:\s*(\d{1,2}\/\d{1,2})/i);
    const release = dateMatch ? formatGame8Date(dateMatch[1]) : null;

    const rewards = [];
    const rewardMatches = trimmed.matchAll(
      /\]\([^\)]+\)\s*([A-Za-z\s'\-]+)\s*(?:\]\([^\)]+\))?\s*(x[\d,\.]+)/gi
    );
    for (const rm of rewardMatches) {
      const itemName = rm[1].trim();
      const itemQty = rm[2].trim();
      if (itemName && itemQty && !itemName.includes('Redeem Code')) {
        rewards.push(`${itemName} ${itemQty}`);
      }
    }

    let expired = null;
    if (
      currentSection.includes('global-exclusive') ||
      currentSection.includes('special program')
    ) {
      const expiryMatch = markdown.match(
        /(?:after|until)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
      );
      if (expiryMatch) {
        expired = formatDate(expiryMatch[1]);
      }
    }

    codes.push({
      kode,
      support_server: ['America', 'Europe', 'Asia', 'TW/HK/Macao'],
      reward: rewards,
      release,
      expired,
      status: getStatus(expired),
      source: 'Game8',
    });
  }

  const uniqueMap = new Map();
  for (const item of codes) {
    if (!uniqueMap.has(item.kode)) {
      uniqueMap.set(item.kode, item);
    }
  }
  return Array.from(uniqueMap.values());
}

async function scrapeViaGame8() {
  // Percobaan 1: Request langsung ke Game8
  try {
    const { data } = await getWithRetry(GAME8_URL);
    if (
      data &&
      typeof data === 'string' &&
      !data.includes('cf-browser-verification') &&
      !data.includes('challenge-running') &&
      !data.includes('<title>Just a moment...</title>')
    ) {
      const codes = await scrapeFromGame8(data);
      if (codes.length > 0) {
        return codes;
      }
    }
  } catch (err) {
    console.warn(`Direct Game8 request gagal (${err.message}), beralih ke Jina Reader proxy...`);
  }

  // Percobaan 2: Request via Jina Reader (menembus Cloudflare WAF pada IP datacenter GitHub Actions)
  try {
    const jinaUrl = `https://r.jina.ai/${GAME8_URL}`;
    const { data } = await getWithRetry(jinaUrl);
    if (data && typeof data === 'string') {
      const codes = scrapeFromGame8Markdown(data);
      if (codes.length > 0) {
        return codes;
      }
    }
  } catch (jinaErr) {
    console.warn(`Jina Reader Game8 request gagal (${jinaErr.message})`);
  }

  throw new Error('Tidak ada kode yang ditemukan di Game8.');
}

async function scrapeFromHtml(html) {
  const $ = load(html);
  const codes = [];

  $('table.wikitable tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    // Hapus elemen referensi footnote (misal: <sup>[1]</sup>) agar tidak menempel pada kode
    $(cells[0]).find('sup, .reference').remove();
    let kode = $(cells[0]).find('code, b, a').first().text().replace(/\s+/g, '').trim();
    if (!kode) {
      kode = $(cells[0]).text().replace(/\s+/g, '').trim();
    }
    kode = kode.replace(/[^A-Za-z0-9]/g, '');

    if (!/^[A-Z0-9]{4,30}$/i.test(kode)) return;

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
      source: 'Fandom',
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
      ? { ...existing, ...code, first_seen: existing.first_seen || now, source: code.source || existing.source || 'Unknown' }
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
      `   Sumber: ${code.source || '-'}`,
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

          // Jeda aman per akun 5.5 detik penuh antar kode untuk antisipasi cooldown HoYoverse
          await delay(5500);
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
