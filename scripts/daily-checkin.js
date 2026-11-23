import { Client } from 'genshin-kit.js';
import { writeFileSync } from 'node:fs';
import {
  loadAccounts,
  getRequiredEnv,
  getWibTime,
  sendTelegramMessage,
  delay,
} from './hoyolab-api.js';

const LOG_FILE = new URL('../log.txt', import.meta.url);

const getRandomDelay = (min = 3000, max = 5000) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function isRateLimitError(error) {
  return (
    error?.response?.status === 429 ||
    /429|too many requests/i.test(String(error?.message || ''))
  );
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
    await delay(1000);
    const rewardInfo = await client.dailyReward.rewardInfo.fetch({ cookie });
    if (rewardInfo) {
      detail += ` | Total login: ${rewardInfo.total_sign_day ?? '-'} | Hari ini: ${rewardInfo.today ?? '-'}`;
    }
  } catch {
    // Detail reward tidak wajib. Check-in utama tetap dianggap memakai hasil checkIn().
  }

  return detail;
}

async function checkInWithRetry(account, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await checkIn(account);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isRateLimitError(error) && !isLastAttempt) {
        const backoffMs = (attempt + 1) * 10000;
        console.warn(`[Rate Limit 429] Terdeteksi pada akun ${account.name}. Menunggu ${backoffMs / 1000} detik sebelum retry...`);
        await delay(backoffMs);
        continue;
      }
      throw error;
    }
  }
}

function isFailure(message) {
  return /error|failed|fail|gagal|captcha|verify|verifikasi/i.test(String(message));
}

function isTokenDead(message) {
  return /not logged in|login expired|login status is invalid|authkey|token expired|tidak ditemukan karakter|cannot find character/i.test(String(message));
}

function getLogAccountName(account, index) {
  const name = account.name.includes('@') ? `Akun ${index + 1}` : account.name;
  return `${name} (${account.source})`;
}

function writeLog(lines) {
  const logEntry = [
    '==================================================',
    ...lines,
    '',
  ].join('\n');

  writeFileSync(LOG_FILE, `${logEntry}\n`, 'utf8');
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
      const detail = await checkInWithRetry(account);
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

    if (index < accounts.length - 1) {
      const sleepTime = getRandomDelay(3000, 5000);
      await delay(sleepTime);
    }
  }

  lines.push(`Berhasil: ${successCount}`);
  lines.push(`Gagal: ${failedCount}`);
  logLines.push(`Berhasil: ${successCount}`);
  logLines.push(`Gagal: ${failedCount}`);

  // Laporkan jika ada akun yang gagal / expired
  if (deadAccounts.length > 0) {
    lines.push('', '⚠️ PERINGATAN: AKUN PERLU DICEK / EXPIRED:');
    for (const dead of deadAccounts) {
      lines.push(
        `- ${dead.account.name} (${dead.account.source})`,
        `  Masalah: ${dead.reason}`,
        ''
      );
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
